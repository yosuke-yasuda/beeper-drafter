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

export function buildPrompt(chat, messages, style = "") {
  const transcript = messages
    .map((m) => `[${m.timestamp}] ${m.isSender ? "ME" : m.senderName ?? m.senderID}: ${m.text ?? `(${m.type})`}`)
    .join("\n");
  return `You triage my chat messages and draft replies for me. I will review every draft before sending.

Chat: "${chat.title}" (${chat.network}, ${chat.type === "group" ? "group chat" : "direct message"})
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
    command: ({ model, effort }) => ({
      cmd: "claude",
      args: [
        "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
        "--system-prompt", SYSTEM_PROMPT,
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
