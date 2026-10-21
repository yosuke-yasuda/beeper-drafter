import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGatePrompt,
  buildPrompt,
  buildSystemOneRequest,
  isCandidate,
  parseGateVerdict,
  parseSystemOneAnswer,
  parseVerdict,
  PROVIDERS,
  recentMessages,
  resolveProvider,
  resolveSystem1,
} from "../lib.mjs";

const chat = { id: "!a", title: "Alex", network: "Discord", type: "single", unreadCount: 1 };

test("isCandidate accepts an unread inbox chat with an empty draft", () => {
  assert.equal(isCandidate(chat), true);
  assert.equal(isCandidate({ ...chat, draft: null }), true);
});

test("isCandidate rejects read, muted, archived, low-priority, read-only, or already-drafted chats", () => {
  for (const override of [
    { unreadCount: 0 },
    { isMuted: true },
    { isArchived: true },
    { isLowPriority: true },
    { isReadOnly: true },
    { draft: { text: "half-written reply" } },
  ]) {
    assert.equal(isCandidate({ ...chat, ...override }), false, JSON.stringify(override));
  }
});

test("recentMessages drops hidden/deleted, sorts oldest first, and keeps the last N", () => {
  const items = [
    { sortKey: "3", text: "c" },
    { sortKey: "1", text: "a" },
    { sortKey: "2", text: "b", isDeleted: true },
    { sortKey: "4", text: "d", isHidden: true },
    { sortKey: "5", text: "e" },
  ];
  assert.deepEqual(
    recentMessages(items, 2).map((m) => m.text),
    ["c", "e"],
  );
});

test("buildPrompt labels my messages as ME and includes the style rules", () => {
  const prompt = buildPrompt(
    chat,
    [
      { timestamp: "t1", senderName: "Alex", text: "Are you free tomorrow?" },
      { timestamp: "t2", isSender: true, text: "Let me check" },
      { timestamp: "t3", senderName: "Alex", type: "IMAGE" },
    ],
    "- Keep it short",
  );
  assert.match(prompt, /Alex: Are you free tomorrow\?/);
  assert.match(prompt, /ME: Let me check/);
  assert.match(prompt, /Alex: \(IMAGE\)/);
  assert.match(prompt, /- Keep it short/);
  assert.match(prompt, /direct message/);
});

test("parseVerdict reads plain, fenced, and repeated JSON", () => {
  const plain = parseVerdict('{"shouldDraft":true,"reason":"asked a question","draft":" Sure! "}');
  assert.deepEqual(plain, { shouldDraft: true, reason: "asked a question", draft: "Sure!" });

  assert.equal(parseVerdict('```json\n{"shouldDraft":false,"reason":"just thanks","draft":""}\n```').shouldDraft, false);

  const repeated = '{"shouldDraft":true,"reason":"r","draft":"hi"}{"shouldDraft":true,"reason":"r","draft":"hi"}';
  assert.equal(parseVerdict(repeated).draft, "hi");
});

test("parseVerdict handles braces and quotes inside the draft", () => {
  const verdict = parseVerdict('{"shouldDraft":true,"reason":"r","draft":"Use {name} and \\"quotes\\" here"}');
  assert.equal(verdict.draft, 'Use {name} and "quotes" here');
});

test("parseVerdict never drafts an empty reply even if the model says to", () => {
  assert.equal(parseVerdict('{"shouldDraft":true,"reason":"x","draft":"   "}').shouldDraft, false);
});

test("parseVerdict throws on output with no JSON", () => {
  assert.throws(() => parseVerdict("I can't help with that."));
});

test("codex is the default provider (works with any ChatGPT account, including Free)", () => {
  assert.equal(resolveProvider().cmd, "codex");
});

test("claude provider: default model, effort flag, and result extraction", () => {
  const ai = resolveProvider({ provider: "claude", effort: "low" });
  assert.equal(ai.cmd, "claude");
  assert.deepEqual(ai.args.slice(ai.args.indexOf("--model"), ai.args.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.deepEqual(ai.args.slice(-2), ["--effort", "low"]);
  assert.equal(ai.extractText(JSON.stringify({ result: "{}" })), "{}");
});

test("codex provider: model, reasoning effort, and stdin prompt", () => {
  const ai = resolveProvider({ provider: "codex", model: "gpt-5.5", effort: "minimal" });
  assert.equal(ai.cmd, "codex");
  assert.equal(ai.args[0], "exec");
  assert.ok(ai.args.includes("gpt-5.5"));
  assert.ok(ai.args.includes("model_reasoning_effort=minimal"));
  assert.equal(ai.args.at(-1), "-");
  assert.ok(!ai.args.includes("-m") || ai.args[ai.args.indexOf("-m") + 1] === "gpt-5.5");
});

test("codex provider omits -m when no model is set, deferring to the CLI default", () => {
  assert.ok(!resolveProvider({ provider: "codex" }).args.includes("-m"));
});

test("resolveProvider rejects unknown providers", () => {
  assert.throws(() => resolveProvider({ provider: "gemini" }), /AI_PROVIDER must be one of: claude, codex/);
  assert.deepEqual(Object.keys(PROVIDERS), ["claude", "codex"]);
});

const msgs = [{ timestamp: "t1", senderName: "Alex", text: "Are you free tomorrow?" }];

test("System 1 is off by default, so the full model judges every chat", () => {
  assert.equal(resolveSystem1({}), null);
  assert.equal(resolveSystem1(), null);
});

test("systemone provider defaults to a local Clef-Flash server", () => {
  const s1 = resolveSystem1({ SYSTEM1_PROVIDER: "systemone" });
  assert.equal(s1.kind, "systemone");
  assert.equal(s1.url, "http://localhost:30000/v1/systemone");
  assert.equal(s1.model, "Cloudflare/clef-flash");
  assert.equal(s1.threshold, 0.3);
  assert.equal(s1.history, 10);
});

test("SYSTEM1_HISTORY sets how many messages the gate sees, separately from HISTORY", () => {
  assert.equal(resolveSystem1({ SYSTEM1_PROVIDER: "systemone", SYSTEM1_HISTORY: "5" }).history, 5);
  for (const bad of ["0", "-1", "2.5", "x"]) {
    assert.throws(() => resolveSystem1({ SYSTEM1_PROVIDER: "systemone", SYSTEM1_HISTORY: bad }), /SYSTEM1_HISTORY must be a positive integer/, bad);
  }
});

test("systemone provider accepts a remote URL, key, and threshold", () => {
  const s1 = resolveSystem1({ SYSTEM1_PROVIDER: "systemone", SYSTEM1_URL: "https://clef.example.com/", SYSTEM1_API_KEY: "k", SYSTEM1_THRESHOLD: "0.1" });
  assert.equal(s1.url, "https://clef.example.com/v1/systemone");
  assert.equal(s1.apiKey, "k");
  assert.equal(s1.threshold, 0.1);
});

test("openai provider needs a model and uses the chat completions endpoint", () => {
  assert.throws(() => resolveSystem1({ SYSTEM1_PROVIDER: "openai" }), /SYSTEM1_MODEL is required/);
  const s1 = resolveSystem1({ SYSTEM1_PROVIDER: "openai", SYSTEM1_MODEL: "gpt-5-nano", OPENAI_API_KEY: "sk" });
  assert.equal(s1.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(s1.apiKey, "sk");
  const local = resolveSystem1({ SYSTEM1_PROVIDER: "openai", SYSTEM1_MODEL: "clef-flash", SYSTEM1_URL: "http://localhost:11434/v1" });
  assert.equal(local.url, "http://localhost:11434/v1/chat/completions");
});

test("CLI System 1 providers use a light model and the gate system prompt", () => {
  const claude = resolveSystem1({ SYSTEM1_PROVIDER: "claude" });
  assert.equal(claude.kind, "cli");
  assert.ok(claude.args.includes("haiku"));
  assert.ok(claude.args.some((a) => a.includes("triage chat messages")));
  const codex = resolveSystem1({ SYSTEM1_PROVIDER: "codex", SYSTEM1_MODEL: "gpt-5.4-mini", SYSTEM1_EFFORT: "minimal" });
  assert.equal(codex.cmd, "codex");
  assert.ok(codex.args.includes("gpt-5.4-mini"));
  assert.ok(codex.args.includes("model_reasoning_effort=minimal"));
});

test("resolveSystem1 rejects unknown providers and bad thresholds", () => {
  assert.throws(() => resolveSystem1({ SYSTEM1_PROVIDER: "gemini" }), /SYSTEM1_PROVIDER must be one of/);
  assert.throws(() => resolveSystem1({ SYSTEM1_PROVIDER: "systemone", SYSTEM1_THRESHOLD: "2" }), /between 0 and 1/);
  assert.throws(() => resolveSystem1({ SYSTEM1_PROVIDER: "systemone", SYSTEM1_THRESHOLD: "x" }), /between 0 and 1/);
});

test("buildSystemOneRequest asks one yes/no question about the transcript", () => {
  const req = buildSystemOneRequest("Cloudflare/clef-flash", chat, msgs);
  assert.equal(req.model, "Cloudflare/clef-flash");
  assert.match(req.state, /Alex: Are you free tomorrow\?/);
  assert.equal(req.questions.needs_reply.type, "noul");
  assert.match(buildGatePrompt(chat, msgs), /"needsReply"/);
});

test("parseSystemOneAnswer reads the plausible yes/no answer shapes", () => {
  // Real Clef-Flash response from llama-server.
  const clef = { model: "ggml-org/Clef-Flash-GGUF:Q4_K_M", answers: { needs_reply: { type: "noul", noul: 0.09569270941000067 } }, usage: { input_tokens: 1568, output_tokens: 0 } };
  assert.equal(parseSystemOneAnswer(clef), 0.09569270941000067);
  assert.equal(parseSystemOneAnswer({ answers: { needs_reply: 0.8 } }), 0.8);
  assert.equal(parseSystemOneAnswer({ answers: { needs_reply: { probability: 0.2 } } }), 0.2);
  assert.equal(parseSystemOneAnswer({ answers: { needs_reply: { true_probability: 0.4 } } }), 0.4);
  assert.equal(parseSystemOneAnswer({ answers: { needs_reply: { probabilities: { true: 0.9, false: 0.1 } } } }), 0.9);
  assert.ok(Math.abs(parseSystemOneAnswer({ answers: { needs_reply: { answer: false, confidence: 0.75 } } }) - 0.25) < 1e-9);
  assert.throws(() => parseSystemOneAnswer({ answers: {} }), /no needs_reply probability/);
  assert.throws(() => parseSystemOneAnswer({ answers: { needs_reply: 3 } }), /not a probability/);
});

test("parseGateVerdict reads a probability or boolean from LLM output", () => {
  assert.deepEqual(parseGateVerdict('```json\n{"needsReply":0.1,"reason":"just thanks"}\n```'), { probability: 0.1, reason: "just thanks" });
  assert.equal(parseGateVerdict('{"needsReply":true}').probability, 1);
  assert.throws(() => parseGateVerdict('{"needsReply":"maybe"}'));
});
