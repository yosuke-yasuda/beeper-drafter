#!/usr/bin/env node
// Beeper -> [optional System 1 gate] -> local AI CLI (Claude Code or Codex) -> draft reply back into Beeper.
// Never sends. Only fills the chat's draft box when it is empty, so you review and hit Enter yourself.
// Opt-in actions (ACTIONS_ENABLED=true, free-text rules in config/ACTIONS.md): when YOU send a message your
// rules cover (e.g. you confirm a meeting time), an AI agent carries them out with the tools you allow.
//
// Usage (see README):
//   npm start                  # event-driven (WebSocket), with a slow reconcile poll
//   npm start -- --once        # one pass over the inbox, then exit
//   npm start -- --dry-run     # print drafts, don't write them
//   npm start -- -v            # also show each step live, including every tool call an action agent makes

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionQuestions,
  buildActionDetectPrompt,
  buildActionPrompt,
  buildGatePrompt,
  buildPrompt,
  buildSystemOneRequest,
  describeEvent,
  GATE_SYSTEM_PROMPT,
  isCandidate,
  isRecent,
  parseActionDetection,
  parseGateVerdict,
  parseSystemOneAnswers,
  parseToolList,
  parseVerdict,
  recentMessages,
  REPLY_QUESTIONS,
  resolveActionAgent,
  resolveProvider,
  resolveSystem1,
  streaming,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BEEPER_URL ?? "http://localhost:23373";
const TOKEN = process.env.BEEPER_TOKEN;
const RECONCILE_MS = Number(process.env.RECONCILE_SECONDS ?? 600) * 1000;
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_SECONDS ?? 1.5) * 1000; // wait for bursts of messages to settle
const HISTORY = Number(process.env.HISTORY ?? 20);
const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("-v") || process.argv.includes("--verbose");
const STATE_FILE = join(HERE, "state.json");
// Your personal style file is gitignored; the example is used until you create one.
const STYLE_FILE = [join(HERE, "config/MESSAGE_STYLE.md"), join(HERE, "config/MESSAGE_STYLE.example.md")].find(existsSync);
// Actions are opt-in: ACTIONS_ENABLED=true, and only your own (gitignored) rules file is read, never the example.
const ACTIONS_ENABLED = process.env.ACTIONS_ENABLED === "true";
const ACTIONS_FILE = join(HERE, "config/ACTIONS.md");
const ACTION_MAX_AGE_MS = Number(process.env.ACTION_MAX_AGE_MINUTES ?? 15) * 60 * 1000;
const DETECT_TIMEOUT_MS = 120 * 1000;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_SECONDS ?? 300) * 1000;

if (!TOKEN) {
  console.error("Set BEEPER_TOKEN in .env (see README: Beeper Desktop > Settings > Integrations > Approved connections > +).");
  process.exit(1);
}

let ai, system1, actionAgent;
let actionRules = ""; // non-empty only when actions are on
try {
  ai = resolveProvider({ provider: process.env.AI_PROVIDER, model: process.env.AI_MODEL, effort: process.env.AI_EFFORT });
  system1 = resolveSystem1(process.env);
  if (ACTIONS_ENABLED) {
    if (!existsSync(ACTIONS_FILE)) throw new Error(`ACTIONS_ENABLED=true but ${ACTIONS_FILE} is missing. Copy config/ACTIONS.example.md there and edit it.`);
    actionRules = readFileSync(ACTIONS_FILE, "utf8").trim();
    if (!actionRules) throw new Error(`ACTIONS_ENABLED=true but ${ACTIONS_FILE} is empty.`);
    actionAgent = resolveActionAgent({
      provider: process.env.ACTION_PROVIDER ?? process.env.AI_PROVIDER,
      model: process.env.ACTION_MODEL,
      effort: process.env.ACTION_EFFORT,
      tools: parseToolList(process.env.ACTION_TOOLS),
    });
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const style = STYLE_FILE ? readFileSync(STYLE_FILE, "utf8") : "";

// -v: a dim, indented line per step, so you can watch what the AI is doing as it happens.
const step = VERBOSE ? (text) => console.log(`\x1b[2m      · ${text}\x1b[0m`) : () => {};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Runs a provider CLI with the prompt on stdin and resolves with its reply text.
// With onLine, the CLI is asked for a JSON event stream and each line is passed to onLine as it arrives.
function runCli(provider, prompt, timeoutMs, onLine) {
  if (onLine) provider = streaming(provider);
  return new Promise((resolve, reject) => {
    const p = spawn(provider.cmd, provider.args, { cwd: HERE, stdio: ["pipe", "pipe", "pipe"] });
    const timer = timeoutMs && setTimeout(() => p.kill(), timeoutMs);
    let out = "", err = "", pending = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (!onLine) return;
      const lines = (pending + d).split("\n");
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line);
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`could not start ${provider.cmd}: ${e.message}`)));
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`${provider.cmd} stopped (${signal}) after ${timeoutMs / 1000}s`));
      if (code !== 0) {
        // Surface the API's own message (e.g. an unsupported AI_EFFORT for this model) instead of the raw log tail.
        const apiError = err.match(/"message":"([^"]+)"/)?.[1];
        return reject(new Error(`${provider.cmd} exited ${code}: ${apiError ?? err.slice(-500)}`));
      }
      try {
        resolve(provider.extractText(out));
      } catch (e) {
        reject(new Error(`could not read ${provider.cmd} output: ${e.message}`));
      }
    });
    p.stdin.end(prompt);
  });
}

async function runModel(prompt) {
  const out = await runCli(ai, prompt);
  try {
    return parseVerdict(out);
  } catch {
    throw new Error(`could not parse ${ai.cmd} output: ${out.slice(0, 500)}`);
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(system1.apiKey ? { Authorization: `Bearer ${system1.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(system1.timeoutMs),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// System 1: asks fast yes/no questions ({id: question}) about the chat. Returns {probabilities: {id: p}, reason}.
async function runSystem1(chat, messages, questions) {
  messages = messages.slice(-system1.history); // the gate sees fewer messages, for speed
  const ids = Object.keys(questions);
  if (system1.kind === "systemone") {
    const body = await postJson(system1.url, buildSystemOneRequest(system1.model, chat, messages, questions));
    return { probabilities: parseSystemOneAnswers(body, ids), reason: system1.model };
  }
  if (system1.kind === "openai") {
    const body = await postJson(system1.url, {
      model: system1.model,
      messages: [
        { role: "system", content: GATE_SYSTEM_PROMPT },
        { role: "user", content: buildGatePrompt(chat, messages, questions) },
      ],
    });
    return parseGateVerdict(body.choices?.[0]?.message?.content ?? "", ids);
  }
  return parseGateVerdict(await runCli(system1, buildGatePrompt(chat, messages, questions)), ids);
}

const formatProbabilities = (probabilities) =>
  Object.entries(probabilities).map(([id, p]) => `${id} p=${p.toFixed(2)}`).join(", ");

async function handleChat(chat, messages) {
  const last = messages.at(-1);
  if (!last || last.isSender) return;
  if (state[chat.id] === last.sortKey) return; // already considered this message

  const markDone = () => {
    state[chat.id] = last.sortKey;
    saveState();
  };
  const tag = `[${chat.network}] ${chat.title}`;

  step(`${tag} — new message from ${last.senderName ?? "them"}`);
  if (system1) {
    try {
      step(`System 1 (${system1.name}): does this need a reply?`);
      const gate = await runSystem1(chat, messages, REPLY_QUESTIONS);
      if (gate.probabilities.needs_reply < system1.threshold) {
        console.log(`skip1 ${tag} — ${formatProbabilities(gate.probabilities)} ${gate.reason}`);
        return markDone();
      }
    } catch (e) {
      // Fail open: a broken or unreachable gate must never cost you a draft.
      console.error(`system1 error ${tag}: ${e.message} (falling back to the full model)`);
    }
  }

  step(`${ai.name}: reading the last ${messages.length} messages, deciding whether to reply and drafting…`);
  const verdict = await runModel(buildPrompt(chat, messages, style));
  if (!verdict.shouldDraft) {
    console.log(`skip  ${tag} — ${verdict.reason}`);
    return markDone();
  }
  console.log(`draft ${tag} — ${verdict.reason}\n      > ${verdict.draft.replace(/\n/g, "\n      > ")}`);
  if (!DRY) {
    await api("PATCH", `/v1/chats/${encodeURIComponent(chat.id)}`, { draft: { text: verdict.draft } });
    step("draft written to Beeper's message box");
  }
  markDone(); // only after a successful write, so a failed draft is retried
}

// When the latest message is one I just sent, checks it against my action rules and, if it explicitly calls
// for one, runs the agent. At most once per message: an action may have side effects, so it is never retried.
async function handleActions(chat, messages) {
  const last = messages.at(-1);
  if (!last?.isSender) return; // only my own sent messages trigger actions
  const key = `action:${chat.id}`;
  if (state[key] === last.sortKey) return; // already considered this message
  const markDone = () => {
    if (DRY) return; // a dry run must not use up the real run's one chance to act on this message
    state[key] = last.sortKey;
    saveState();
  };
  if (!isRecent(last, Date.now(), ACTION_MAX_AGE_MS)) return markDone();
  const tag = `[${chat.network}] ${chat.title}`;

  step(`${tag} — you sent a message, checking it against your action rules`);
  if (system1) {
    try {
      step(`System 1 (${system1.name}): does it call for an action?`);
      const gate = await runSystem1(chat, messages, actionQuestions(actionRules));
      if (gate.probabilities.action < system1.threshold) {
        console.log(`skip1 ${tag} — your message: ${formatProbabilities(gate.probabilities)}`);
        return markDone();
      }
    } catch (e) {
      console.error(`system1 error ${tag}: ${e.message} (falling back to the full model)`);
    }
  }

  step(`${ai.name}: does your message commit to something your rules cover?`);
  const detectOut = await runCli(ai, buildActionDetectPrompt(chat, messages, actionRules, TIME_ZONE), DETECT_TIMEOUT_MS);
  let detected;
  try {
    detected = parseActionDetection(detectOut);
  } catch {
    throw new Error(`could not parse ${ai.cmd} action detection: ${detectOut.slice(0, 500)}`);
  }
  markDone();
  if (!detected.triggered) return console.log(`check ${tag} — your message: no action (${detected.reason || "no reason given"})`);

  console.log(`act   ${tag} — your message: ${detected.action}${detected.details ? ` (${detected.details})` : ""}`);
  if (DRY) return console.log("      (dry run: agent not started)");
  try {
    step(`${actionAgent.name} agent: starting`);
    const onLine = VERBOSE ? (line) => describeEvent(actionAgent.cmd, line).forEach(step) : undefined;
    const out = await runCli(actionAgent, buildActionPrompt(actionRules, detected, chat, messages, TIME_ZONE), ACTION_TIMEOUT_MS, onLine);
    console.log(`      > ${out.trim().slice(0, 500).replace(/\n/g, "\n      > ")}`);
  } catch (e) {
    console.error(`action error ${tag}: ${e.message}`);
  }
}

// Serialize work so two events never draft the same chat concurrently.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error(e.message)));

async function processChat(chat) {
  const wantDraft = isCandidate(chat);
  const wantActions = Boolean(actionRules) && !chat.isReadOnly;
  if (!wantDraft && !wantActions) return;
  try {
    const page = await api("GET", `/v1/chats/${encodeURIComponent(chat.id)}/messages`);
    const messages = recentMessages(page.items ?? [], HISTORY);
    if (wantActions) await handleActions(chat, messages);
    if (wantDraft) await handleChat(chat, messages);
  } catch (e) {
    console.error(`error ${chat.title}: ${e.message}`);
  }
}

async function reconcile() {
  const { items = [] } = await api("GET", "/v1/chats?limit=50");
  for (const chat of items) await processChat(chat);
}

const timers = new Map();
function onNewMessage(chatID) {
  clearTimeout(timers.get(chatID));
  timers.set(
    chatID,
    setTimeout(() => {
      timers.delete(chatID);
      enqueue(async () => processChat(await api("GET", `/v1/chats/${encodeURIComponent(chatID)}`)));
    }, DEBOUNCE_MS),
  );
}

function connect() {
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/v1/ws", { headers: { Authorization: `Bearer ${TOKEN}` } });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "ready") {
      ws.send(JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"] }));
      const gate = system1 ? `, system1 ${system1.name} < ${system1.threshold} skips` : "";
      console.log(`connected to Beeper, listening for messages (${ai.name}${process.env.AI_EFFORT ? `, effort ${process.env.AI_EFFORT}` : ""}${gate})`);
      enqueue(reconcile); // catch anything missed while disconnected
    } else if (msg.type === "message.upserted") {
      onNewMessage(msg.chatID);
    } else if (msg.type === "error") {
      console.error("ws error:", JSON.stringify(msg));
    }
  };
  ws.onclose = async () => {
    // The WebSocket doesn't say why it closed, so ask over HTTP: a rejected token won't fix itself by retrying.
    const res = await fetch(`${BASE}/v1/chats?limit=1`, { headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => null);
    if (res?.status === 401 || res?.status === 403) {
      console.error(`Beeper rejected BEEPER_TOKEN (${res.status} ${res.statusText}). Create a new token (see README) and restart.`);
      process.exit(1);
    }
    console.error("disconnected from Beeper, retrying in 5s");
    setTimeout(connect, 5000);
  };
  ws.onerror = () => {}; // onclose handles retry
}

if (actionRules) {
  console.log(`ACTIONS ON${DRY ? " (dry run: the agent won't start)" : ""}: when YOU send a message that commits to something (e.g. confirming a meeting time), a ${actionAgent.name} agent acts on it following ${ACTIONS_FILE}.`);
  console.log(`  tools it may use: ${actionAgent.toolScope}`);
}

if (ONCE) {
  await reconcile();
} else {
  connect();
  setInterval(() => enqueue(reconcile), RECONCILE_MS);
}
