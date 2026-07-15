import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Minimal shape of the Telegram Desktop JSON export (result.json). We only
 * declare the fields we read; the export contains many more.
 */
interface RawTextEntity {
  type: string;
  text: string;
}
type RawText = string | (string | RawTextEntity)[];

interface RawMessage {
  id: number;
  type?: string;
  date_unixtime?: string;
  from?: string;
  from_id?: string;
  reply_to_message_id?: number;
  text?: RawText;
  text_entities?: RawTextEntity[];
}

interface RawChat {
  name?: string;
  type?: string;
  id?: number;
  messages?: RawMessage[];
}

interface RawExport {
  name?: string;
  type?: string;
  id?: number;
  messages?: RawMessage[];
  chats?: { list?: RawChat[] };
}

export interface NormalizedMessage {
  id: number;
  chatId: string;
  chatTitle: string;
  fromId: string;
  fromName: string;
  isSelf: boolean;
  text: string;
  tsUnix: number;
  replyToId: number | null;
}

/** An incoming message paired with your reply to it. */
export interface Pair {
  chatId: string;
  incoming: string;
  reply: string;
}

export interface ParsedExport {
  chats: Map<string, { title: string; messages: NormalizedMessage[] }>;
  selfMessages: NormalizedMessage[];
  pairs: Pair[];
}

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const URL = /\bhttps?:\/\/\S+/gi;
const HANDLE = /(^|[^\w@])@\w{3,}/g;
// Phone-ish: 7+ digits, optionally grouped with spaces/dashes/parens/plus.
const PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

/**
 * Redact obvious PII from a contact's message so it can be stored in
 * persona.json as a style example without leaking personal data.
 * `names` are display names collected from the export that also get masked.
 */
export function redactPii(text: string, names: Iterable<string> = []): string {
  let out = text
    .replace(EMAIL, "[email]")
    .replace(URL, "[link]")
    .replace(HANDLE, (m) => m.replace(/@\w+/, "@handle"))
    .replace(PHONE, (m) => (/\d{7,}/.test(m.replace(/\D/g, "")) ? "[phone]" : m));

  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length < 3) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[name]");
  }
  return out;
}

/** Flatten Telegram's mixed text representation into a plain string. */
function extractText(msg: RawMessage): string {
  if (Array.isArray(msg.text_entities) && msg.text_entities.length > 0) {
    return msg.text_entities.map((e) => e.text).join("");
  }
  const t = msg.text;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return t.map((part) => (typeof part === "string" ? part : part.text)).join("");
  }
  return "";
}

function normalizeChat(chat: RawChat, selfId: string): NormalizedMessage[] {
  const chatId = String(chat.id ?? "unknown");
  const chatTitle = chat.name ?? "unknown";
  const out: NormalizedMessage[] = [];
  for (const msg of chat.messages ?? []) {
    if (msg.type && msg.type !== "message") continue;
    const text = extractText(msg).trim();
    if (!text) continue;
    const fromId = msg.from_id ?? "unknown";
    out.push({
      id: msg.id,
      chatId,
      chatTitle,
      fromId,
      fromName: msg.from ?? "unknown",
      isSelf: fromId === selfId,
      text,
      tsUnix: Number(msg.date_unixtime ?? 0),
      replyToId: msg.reply_to_message_id ?? null,
    });
  }
  return out;
}

/**
 * Parse a Telegram Desktop export into normalized messages, your own
 * messages, and (incoming -> your reply) pairs with contact PII redacted.
 */
export function parseExport(raw: RawExport, selfId: string): ParsedExport {
  const rawChats: RawChat[] = raw.chats?.list
    ? raw.chats.list
    : [{ name: raw.name, type: raw.type, id: raw.id, messages: raw.messages }];

  const chats = new Map<string, { title: string; messages: NormalizedMessage[] }>();
  const selfMessages: NormalizedMessage[] = [];
  const pairs: Pair[] = [];

  for (const rawChat of rawChats) {
    const messages = normalizeChat(rawChat, selfId);
    if (messages.length === 0) continue;
    const first = messages[0]!;
    chats.set(first.chatId, { title: first.chatTitle, messages });

    const names = new Set(messages.filter((m) => !m.isSelf).map((m) => m.fromName));
    const byId = new Map(messages.map((m) => [m.id, m]));

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (!m.isSelf) continue;
      selfMessages.push(m);

      // Prefer an explicit reply target; otherwise the previous message from
      // someone else that comes right before this one.
      let incoming: NormalizedMessage | undefined;
      if (m.replyToId !== null) {
        const target = byId.get(m.replyToId);
        if (target && !target.isSelf) incoming = target;
      }
      if (!incoming) {
        for (let j = i - 1; j >= 0; j--) {
          const prev = messages[j]!;
          if (!prev.isSelf) {
            incoming = prev;
            break;
          }
          // A self message immediately before means this reply continues our
          // own turn; stop so we don't attribute it to an old incoming.
          break;
        }
      }
      if (!incoming) continue;

      pairs.push({
        chatId: m.chatId,
        incoming: redactPii(incoming.text, names),
        reply: redactPii(m.text, names),
      });
    }
  }

  return { chats, selfMessages, pairs };
}

/**
 * Repair a truncated JSON export by closing brackets left open at EOF.
 * Telegram exports of large accounts can be cut off mid-write; this recovers
 * every complete element up to the truncation point. Returns null if it can't
 * find a clean point to repair from.
 */
export function repairTruncatedJson(text: string): string | null {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let cleanIdx = -1;
  let cleanStack: string[] = [];

  const mark = (idx: number) => {
    cleanIdx = idx;
    cleanStack = [...stack];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') {
        inStr = false;
        mark(i + 1);
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{" || c === "[") {
      stack.push(c);
    } else if (c === "}" || c === "]") {
      stack.pop();
      mark(i + 1);
    } else if (c === ",") {
      mark(i); // clean point is just before the comma
    }
  }

  if (cleanIdx === -1 || cleanStack.length === 0) return null;

  let prefix = text.slice(0, cleanIdx).replace(/,\s*$/, "");
  for (let i = cleanStack.length - 1; i >= 0; i--) {
    prefix += cleanStack[i] === "{" ? "}" : "]";
  }
  return prefix;
}

/** Read and parse an export file from disk, repairing truncation if needed. */
export function loadExport(path: string, selfId: string): ParsedExport {
  const text = readFileSync(path, "utf8");
  let raw: RawExport;
  try {
    raw = JSON.parse(text) as RawExport;
  } catch (err) {
    const repaired = repairTruncatedJson(text);
    if (repaired === null) throw err;
    raw = JSON.parse(repaired) as RawExport;
    console.warn(
      "Warning: the export was truncated (incomplete file). Recovered all complete messages up to the cut-off point.",
    );
  }
  return parseExport(raw, selfId);
}

// CLI: summarize an export. Usage: npm run parse -- <export.json> [selfUserId]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , file, selfArg] = process.argv;
  if (!file) {
    console.error("Usage: npm run parse -- <export.json> [selfUserId]");
    process.exit(1);
  }
  const selfId = selfArg ?? process.env.SELF_USER_ID ?? "";
  if (!selfId) {
    console.error("Provide your self user id as the 2nd argument or via SELF_USER_ID.");
    process.exit(1);
  }
  const parsed = loadExport(file, selfId);
  console.log(`chats:        ${parsed.chats.size}`);
  console.log(`your messages: ${parsed.selfMessages.length}`);
  console.log(`reply pairs:   ${parsed.pairs.length}`);
}
