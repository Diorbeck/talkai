import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Build and connect a TelegramClient from the saved session string.
 * Throws if no session is configured — run `npm run login` first.
 */
export async function buildClient(cfg: Config): Promise<TelegramClient> {
  if (!cfg.telegram.session) {
    throw new Error("TELEGRAM_SESSION is empty. Run `npm run login` and set it in your .env.");
  }

  const client = new TelegramClient(
    new StringSession(cfg.telegram.session),
    cfg.telegram.apiId,
    cfg.telegram.apiHash,
    { connectionRetries: 5, autoReconnect: true },
  );

  await client.connect();

  const me = await client.getMe();
  const meId = "id" in me ? String(me.id) : "unknown";
  logger.info({ meId }, "connected to Telegram");

  return client;
}
