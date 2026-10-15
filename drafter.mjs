#!/usr/bin/env node
// Beeper -> local AI CLI (Claude Code or Codex) -> draft reply back into Beeper.
// Never sends. Only fills the chat's draft box when it is empty, so you review and hit Enter yourself.
//
// Usage (see README):
//   npm start                  # event-driven (WebSocket), with a slow reconcile poll
//   npm start -- --once        # one pass over the inbox, then exit
//   npm start -- --dry-run     # print drafts, don't write them

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, isCandidate, parseVerdict, recentMessages, resolveProvider } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BEEPER_URL ?? "http://localhost:23373";
const TOKEN = process.env.BEEPER_TOKEN;
const RECONCILE_MS = Number(process.env.RECONCILE_SECONDS ?? 600) * 1000;
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_SECONDS ?? 1.5) * 1000; // wait for bursts of messages to settle
const HISTORY = Number(process.env.HISTORY ?? 20);
const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run");
const STATE_FILE = join(HERE, "state.json");
// Your personal style file is gitignored; the example is used until you create one.
const STYLE_FILE = [join(HERE, "config/MESSAGE_STYLE.md"), join(HERE, "config/MESSAGE_STYLE.example.md")].find(existsSync);

if (!TOKEN) {
  console.error("Set BEEPER_TOKEN in .env (see README: Beeper Desktop > Settings > Integrations > Approved connections > +).");
  process.exit(1);
}

let ai;
try {
  ai = resolveProvider({ provider: process.env.AI_PROVIDER, model: process.env.AI_MODEL, effort: process.env.AI_EFFORT });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const style = STYLE_FILE ? readFileSync(STYLE_FILE, "utf8") : "";

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function runModel(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn(ai.cmd, ai.args, { cwd: HERE, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`could not start ${ai.cmd}: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) {
        // Surface the API's own message (e.g. an unsupported AI_EFFORT for this model) instead of the raw log tail.
        const apiError = err.match(/"message":"([^"]+)"/)?.[1];
        return reject(new Error(`${ai.cmd} exited ${code}: ${apiError ?? err.slice(-500)}`));
      }
      try {
        resolve(parseVerdict(ai.extractText(out)));
      } catch {
        reject(new Error(`could not parse ${ai.cmd} output: ${out.slice(0, 500)}`));
      }
    });
    p.stdin.end(prompt);
  });
}

async function handleChat(chat) {
  const page = await api("GET", `/v1/chats/${encodeURIComponent(chat.id)}/messages`);
  const messages = recentMessages(page.items ?? [], HISTORY);
  const last = messages.at(-1);
  if (!last || last.isSender) return;
  if (state[chat.id] === last.sortKey) return; // already considered this message

  const verdict = await runModel(buildPrompt(chat, messages, style));
  const markDone = () => {
    state[chat.id] = last.sortKey;
    saveState();
  };

  const tag = `[${chat.network}] ${chat.title}`;
  if (!verdict.shouldDraft) {
    console.log(`skip  ${tag} — ${verdict.reason}`);
    return markDone();
  }
  console.log(`draft ${tag} — ${verdict.reason}\n      > ${verdict.draft.replace(/\n/g, "\n      > ")}`);
  if (!DRY) await api("PATCH", `/v1/chats/${encodeURIComponent(chat.id)}`, { draft: { text: verdict.draft } });
  markDone(); // only after a successful write, so a failed draft is retried
}

// Serialize work so two events never draft the same chat concurrently.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error(e.message)));

async function processChat(chat) {
  if (!isCandidate(chat)) return;
  try {
    await handleChat(chat);
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
      console.log(`connected to Beeper, listening for messages (${ai.name}${process.env.AI_EFFORT ? `, effort ${process.env.AI_EFFORT}` : ""})`);
      enqueue(reconcile); // catch anything missed while disconnected
    } else if (msg.type === "message.upserted") {
      onNewMessage(msg.chatID);
    } else if (msg.type === "error") {
      console.error("ws error:", JSON.stringify(msg));
    }
  };
  ws.onclose = () => {
    console.error("disconnected from Beeper, retrying in 5s");
    setTimeout(connect, 5000);
  };
  ws.onerror = () => {}; // onclose handles retry
}

if (ONCE) {
  await reconcile();
} else {
  connect();
  setInterval(() => enqueue(reconcile), RECONCILE_MS);
}
