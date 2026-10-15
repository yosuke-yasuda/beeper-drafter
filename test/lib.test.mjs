import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, isCandidate, parseVerdict, PROVIDERS, recentMessages, resolveProvider } from "../lib.mjs";

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
