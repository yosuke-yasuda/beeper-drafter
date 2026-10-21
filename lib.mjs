// Pure logic, kept free of I/O so it can be unit-tested without Beeper or an AI CLI.

// A chat is worth looking at only if it has unread messages, is in the normal inbox,
// and has an empty draft box (we never overwrite something you started typing).
export const isCandidate = (c) =>
  c.unreadCount > 0 && !c.isMuted && !c.isReadOnly && !c.isArchived && !c.isLowPriority && !c.draft?.text;

export const recentMessages = (items, limit) =>
  items
    .filter((m) => !m.isHidden && !m.isDeleted)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
    .slice(-limit);

const formatTranscript = (messages) =>
  messages
    .map((m) => `[${m.timestamp}] ${m.isSender ? "ME" : m.senderName ?? m.senderID}: ${m.text ?? `(${m.type})`}`)
    .join("\n");

const describeChat = (chat) =>
  `"${chat.title}" (${chat.network}, ${chat.type === "group" ? "group chat" : "direct message"})`;

export function buildPrompt(chat, messages, style = "") {
  const transcript = formatTranscript(messages);
  return `You triage my chat messages and draft replies for me. I will review every draft before sending.

Chat: ${describeChat(chat)}
${style ? `\nMy writing style / rules:\n${style}\n` : ""}
Recent messages (oldest first):
${transcript}

Decide whether a reply from ME is appropriate right now.
Do NOT draft when: the last messages need no reply (thanks, FYI, emoji, automated/notification/marketing), it's a group chat where I'm not addressed, or answering needs facts only I know (then say so in "reason").
If drafting: reply in the same language as the conversation, short and natural, in my voice. Never invent commitments, dates, or facts.

Respond with ONLY JSON: {"shouldDraft": boolean, "reason": string, "draft": string}`;
}

export const SYSTEM_PROMPT = "You triage chat messages and draft replies. Output only JSON.";

// Each provider is a local CLI you're already logged into, so drafting runs on your subscription.
// Both invocations are kept lean (no tools, MCP, user config, or project rules) for speed and cost.
export const PROVIDERS = {
  claude: {
    defaultModel: "sonnet",
    command: ({ model, effort, systemPrompt = SYSTEM_PROMPT }) => ({
      cmd: "claude",
      args: [
        "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
        "--system-prompt", systemPrompt,
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
      ],
    }),
    extractText: (stdout) => JSON.parse(stdout).result ?? "",
  },
  codex: {
    defaultModel: undefined, // whatever your Codex CLI defaults to
    command: ({ model, effort }) => ({
      cmd: "codex",
      args: [
        "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only",
        ...(model ? ["-m", model] : []),
        ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
        "-", // read the prompt from stdin
      ],
    }),
    extractText: (stdout) => stdout,
  },
};

export function resolveProvider({ provider = "codex", model, effort } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`AI_PROVIDER must be one of: ${Object.keys(PROVIDERS).join(", ")} (got "${provider}")`);
  // Effort is passed through unvalidated: the accepted levels depend on the model, and the CLI says which.
  return { ...p, name: provider, ...p.command({ model: model || p.defaultModel, effort }) };
}

// Returns the first complete {...} object in the text. Models sometimes wrap JSON
// in prose or a code fence, or repeat it.
function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in model output");
}

// Parses the model's reply text into a verdict.
export function parseVerdict(text) {
  const verdict = firstJsonObject(text);
  return {
    shouldDraft: verdict.shouldDraft === true && typeof verdict.draft === "string" && verdict.draft.trim() !== "",
    reason: String(verdict.reason ?? ""),
    draft: typeof verdict.draft === "string" ? verdict.draft.trim() : "",
  };
}

// --- System 1: an optional fast "does this need a reply?" gate before the full drafting call ---
// Off unless SYSTEM1_PROVIDER is set. It can only skip chats; anything it lets through still
// goes to the full model, which may skip it too.

const REPLY_QUESTION =
  "Does ME need to send a reply now? True if the latest messages from others ask ME something, expect a response, " +
  "or would be rude to leave unanswered. False for thanks, FYI, emoji or reactions, automated, notification, or " +
  "marketing messages, and group chats where ME isn't addressed.";

const gateState = (chat, messages) => `Chat: ${describeChat(chat)}\n\nRecent messages (oldest first):\n${formatTranscript(messages)}`;

export const GATE_SYSTEM_PROMPT = "You triage chat messages. Output only JSON.";

export const buildGatePrompt = (chat, messages) => `${gateState(chat, messages)}

${REPLY_QUESTION}

Respond with ONLY JSON: {"needsReply": number from 0 to 1 (your probability that a reply is needed), "reason": string}`;

// Request body for a Clef / Jev / SystemOne-compatible /v1/systemone endpoint.
export const buildSystemOneRequest = (model, chat, messages) => ({
  model,
  state: gateState(chat, messages),
  questions: { needs_reply: { type: "noul", instructions: REPLY_QUESTION } },
});

const clampProbability = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`not a probability: ${n}`);
  return n;
};

// Reads P(true) for the needs_reply question. Clef (llama.cpp) answers
// {"type":"noul","noul":0.09}; other SystemOne-style servers may use another shape, so accept those too.
export function parseSystemOneAnswer(body) {
  const a = body?.answers?.needs_reply;
  if (typeof a === "number") return clampProbability(a);
  for (const key of ["noul", "probability", "true_probability", "p_true", "value"]) {
    if (typeof a?.[key] === "number") return clampProbability(a[key]);
  }
  if (typeof a?.probabilities?.true === "number") return clampProbability(a.probabilities.true);
  const verdict = a?.answer ?? a?.value ?? a?.choice;
  if (typeof verdict === "boolean" && typeof a?.confidence === "number") {
    return clampProbability(verdict ? a.confidence : 1 - a.confidence);
  }
  throw new Error(`no needs_reply probability in response: ${JSON.stringify(body).slice(0, 300)}`);
}

// Parses an LLM gate reply ({"needsReply": 0..1 or boolean, "reason"}) into a probability.
export function parseGateVerdict(text) {
  const v = firstJsonObject(text);
  const p = typeof v.needsReply === "boolean" ? Number(v.needsReply) : clampProbability(v.needsReply);
  return { probability: p, reason: String(v.reason ?? "") };
}

export const SYSTEM1_PROVIDERS = ["systemone", "openai", "codex", "claude"];

export function resolveSystem1(env = {}) {
  const provider = env.SYSTEM1_PROVIDER;
  if (!provider) return null;
  const threshold = Number(env.SYSTEM1_THRESHOLD ?? 0.3);
  if (!(threshold >= 0 && threshold <= 1)) throw new Error(`SYSTEM1_THRESHOLD must be between 0 and 1 (got "${env.SYSTEM1_THRESHOLD}")`);
  const history = Number(env.SYSTEM1_HISTORY ?? 10);
  if (!(Number.isInteger(history) && history > 0)) throw new Error(`SYSTEM1_HISTORY must be a positive integer (got "${env.SYSTEM1_HISTORY}")`);
  const base = { name: provider, threshold, history, timeoutMs: Number(env.SYSTEM1_TIMEOUT_SECONDS ?? 15) * 1000 };
  const url = (fallback) => (env.SYSTEM1_URL || fallback).replace(/\/+$/, "");

  if (provider === "systemone") {
    return { ...base, kind: "systemone", url: url("http://localhost:30000") + "/v1/systemone", model: env.SYSTEM1_MODEL || "Cloudflare/clef-flash", apiKey: env.SYSTEM1_API_KEY };
  }
  if (provider === "openai") {
    if (!env.SYSTEM1_MODEL) throw new Error("SYSTEM1_MODEL is required with SYSTEM1_PROVIDER=openai (e.g. gpt-5-nano, or an Ollama model name)");
    return { ...base, kind: "openai", url: url("https://api.openai.com/v1") + "/chat/completions", model: env.SYSTEM1_MODEL, apiKey: env.SYSTEM1_API_KEY ?? env.OPENAI_API_KEY };
  }
  if (provider === "codex" || provider === "claude") {
    const model = env.SYSTEM1_MODEL || (provider === "claude" ? "haiku" : undefined);
    const cli = PROVIDERS[provider].command({ model, effort: env.SYSTEM1_EFFORT, systemPrompt: GATE_SYSTEM_PROMPT });
    return { ...base, kind: "cli", ...PROVIDERS[provider], ...cli };
  }
  throw new Error(`SYSTEM1_PROVIDER must be one of: ${SYSTEM1_PROVIDERS.join(", ")} (got "${provider}")`);
}
