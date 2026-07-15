import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadTelegramEnv } from "./config.js";
import { ask, askHidden } from "./prompt.js";
import { logger } from "./logger.js";

/** Write TELEGRAM_SESSION into .env, preserving the other lines. */
function saveSessionToEnv(session: string): boolean {
  try {
    const lines = existsSync(".env") ? readFileSync(".env", "utf8").split(/\r?\n/) : [];
    let found = false;
    const updated = lines.map((line) => {
      if (line.trim().startsWith("TELEGRAM_SESSION=")) {
        found = true;
        return `TELEGRAM_SESSION=${session}`;
      }
      return line;
    });
    if (!found) updated.push(`TELEGRAM_SESSION=${session}`);
    writeFileSync(".env", updated.join("\n").replace(/\n+$/, "\n"));
    return true;
  } catch (err) {
    logger.warn({ err }, "could not write session to .env");
    return false;
  }
}

/**
 * One-time interactive login: phone -> code -> optional 2FA password.
 * Saves the session string into .env automatically (and prints it as a backup).
 * Nothing is sent or read beyond authenticating your own account.
 */
async function main(): Promise<void> {
  const { apiId, apiHash } = loadTelegramEnv();

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

  const wrote = saveSessionToEnv(saved);
  if (wrote) {
    console.log("\nLogin successful. The session was saved to .env automatically.");
    console.log("You can now run: npm run chats  and then  npm start");
  } else {
    console.log("\nLogin successful. Add this line to your .env file manually:\n");
    console.log(`TELEGRAM_SESSION=${saved}\n`);
  }
  console.log("Keep .env secret — the session grants full access to your Telegram account.");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "login failed");
  process.exit(1);
});
