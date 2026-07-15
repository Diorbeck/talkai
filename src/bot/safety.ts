import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import type { SuggestionStore } from "../db.js";

const HOUR_MS = 60 * 60 * 1000;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesNowInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

export interface Gate {
  ok: boolean;
  reason: string;
}

/**
 * Central safety checks. Every one of these must pass before a suggestion is
 * even generated, and again (rate limit) before an outbound send is allowed.
 */
export class SafetyGate {
  constructor(
    private readonly cfg: Config,
    private readonly store: SuggestionStore,
  ) {}

  /** A kill switch: create the configured file to halt all activity. */
  isKilled(): boolean {
    return existsSync(this.cfg.runtime.killSwitchFile);
  }

  isActiveNow(): boolean {
    const { start, end, timezone } = this.cfg.runtime.activeHours;
    const now = minutesNowInTz(timezone);
    const s = toMinutes(start);
    const e = toMinutes(end);
    return s <= e ? now >= s && now < e : now >= s || now < e;
  }

  /** Whether the chat is one you have opted into watching. */
  isChatAllowed(chatId: string): boolean {
    const { allowlist, denylist } = this.cfg.runtime;
    if (denylist.includes(chatId)) return false;
    if (allowlist.length === 0) return false; // default-deny: nothing until opted in
    return allowlist.includes(chatId);
  }

  /** Combined precondition for generating a suggestion for an incoming message. */
  canConsider(chatId: string): Gate {
    if (this.isKilled()) return { ok: false, reason: "kill switch active" };
    if (!this.isActiveNow()) return { ok: false, reason: "outside active hours" };
    if (!this.isChatAllowed(chatId)) return { ok: false, reason: "chat not in allowlist" };
    return { ok: true, reason: "ok" };
  }

  /** Rate-limit check performed immediately before an outbound send. */
  canSend(chatId: string): Gate {
    if (this.isKilled()) return { ok: false, reason: "kill switch active" };
    const since = Date.now() - HOUR_MS;
    const perChat = this.store.countSentSince(chatId, since);
    if (perChat >= this.cfg.runtime.rateLimit.perChatPerHour) {
      return { ok: false, reason: "per-chat hourly limit reached" };
    }
    const global = this.store.countSentSince(null, since);
    if (global >= this.cfg.runtime.rateLimit.globalPerHour) {
      return { ok: false, reason: "global hourly limit reached" };
    }
    return { ok: true, reason: "ok" };
  }
}
