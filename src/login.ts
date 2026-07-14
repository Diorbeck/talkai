import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadTelegramEnv } from "./config.js";
import { ask, askHidden } from "./prompt.js";
import { logger } from "./logger.js";

/**
 * One-time interactive login: phone -> code -> optional 2FA password.
 * Prints a session string to paste into TELEGRAM_SESSION in your .env.
 * Nothing is sent or read beyond authenticating your own account.
 */
async function main(): Promise<void> {
  const { apiId, apiHash, session } = loadTelegramEnv();

  if (session) {
    logger.warn(
      "TELEGRAM_SESSION is already set in your environment. Logging in again will produce a new session string.",
    );
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => ask("Phone number (international format, e.g. +99890...): "),
    phoneCode: async () => ask("Login code (sent via Telegram): "),
    password: async () => askHidden("2FA password (leave blank if none): "),
    onError: (err) => logger.error({ err }, "login error"),
  });

  const saved = client.session.save() as unknown as string;
  await client.disconnect();

  console.log("\nLogin successful. Add this line to your .env file:\n");
  console.log(`TELEGRAM_SESSION=${saved}\n`);
  console.log("Keep it secret — it grants full access to your Telegram account.");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "login failed");
  process.exit(1);
});
