import type { TelegramClient } from "telegram";
import type { NewMessageEvent } from "telegram/events/index.js";
import type { EntityLike } from "telegram/define.js";
import type { Config } from "../config.js";
import type { Persona } from "../llm/persona.js";
import type { SuggestionStore, Decision } from "../db.js";
import { SafetyGate } from "./safety.js";
import { generateDraft, type ContextTurn } from "../llm/generate.js";
import { reviewDraft } from "./review.js";
import { logger } from "../logger.js";

const CONTEXT_LIMIT = 8;

export interface HandlerDeps {
  client: TelegramClient;
  cfg: Config;
  persona: Persona;
  store: SuggestionStore;
  gate: SafetyGate;
}

async function chatTitleOf(event: NewMessageEvent): Promise<string> {
  try {
    const chat = await event.getChat();
    if (chat && "title" in chat && chat.title) return String(chat.title);
    if (chat && "firstName" in chat && chat.firstName) return String(chat.firstName);
    if (chat && "username" in chat && chat.username) return String(chat.username);
  } catch {
    /* fall through */
  }
  return "unknown";
}

async function gatherContext(
  client: TelegramClient,
  peer: EntityLike,
  excludeId: number,
): Promise<ContextTurn[]> {
  try {
    const msgs = await client.getMessages(peer, { limit: CONTEXT_LIMIT });
    const turns: ContextTurn[] = [];
    for (const m of msgs) {
      if (m.id === excludeId) continue;
      const text = m.message?.trim();
      if (!text) continue;
      turns.push({ fromSelf: Boolean(m.out), text });
    }
    return turns.reverse(); // chronological order
  } catch (err) {
    logger.warn({ err }, "could not fetch context");
    return [];
  }
}

/** Build the NewMessage handler that runs the full review pipeline. */
export function makeHandler(deps: HandlerDeps) {
  const { client, cfg, persona, store, gate } = deps;

  return async function onNewMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (msg.out) return; // our own outgoing message
    const incoming = msg.text?.trim();
    if (!incoming) return;

    const peer = event.chatId;
    if (!peer) return;
    const chatId = String(peer);
    const gateResult = gate.canConsider(chatId);
    if (!gateResult.ok) {
      logger.debug({ chatId, reason: gateResult.reason }, "skipping message");
      return;
    }

    const chatTitle = await chatTitleOf(event);
    const context = await gatherContext(client, peer, msg.id);

    const result = await generateDraft(cfg, persona, { incoming, context });

    const base = {
      ts: Date.now(),
      chat_id: chatId,
      chat_title: chatTitle,
      incoming_text: incoming,
      draft: result.draft,
      reason: result.reason,
      model: cfg.anthropic.model,
    };

    if (result.draft === null) {
      logger.info({ chatId, reason: result.reason }, "no draft (declined)");
      store.record({ ...base, decision: "suppressed", sent_text: null });
      return;
    }

    const outcome = await reviewDraft(client, cfg, {
      chatId,
      chatTitle,
      incoming,
      draft: result.draft,
      reason: result.reason,
    });

    if (outcome.decision === "skipped" || !outcome.text) {
      store.record({ ...base, decision: "skipped", sent_text: null });
      return;
    }

    const sendGate = gate.canSend(chatId);
    if (!sendGate.ok) {
      logger.warn({ chatId, reason: sendGate.reason }, "send blocked");
      console.log(`(not sent: ${sendGate.reason})`);
      store.record({ ...base, decision: "suppressed", sent_text: null });
      return;
    }

    try {
      await client.sendMessage(peer, { message: outcome.text });
      logger.info({ chatId }, "reply sent");
      const decision: Decision =
        outcome.decision === "edited_sent" ? "edited_sent" : "sent";
      store.record({ ...base, decision, sent_text: outcome.text });
    } catch (err) {
      logger.error({ err, chatId }, "failed to send reply");
      store.record({ ...base, decision: "skipped", sent_text: null });
    }
  };
}
