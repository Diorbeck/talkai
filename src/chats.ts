import { loadConfig } from "./config.js";
import { buildClient } from "./bot/client.js";
import { logger } from "./logger.js";

/**
 * List your Telegram dialogs with their ids, so you can fill
 * runtime.allowlist / denylist in config.json. Read-only: fetches the dialog
 * list and prints it, nothing else.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = await buildClient(cfg);

  const dialogs = await client.getDialogs({ limit: 100 });

  console.log("\nid                    kind        title");
  console.log("────────────────────  ──────────  ─────────────────────────────");
  for (const d of dialogs) {
    const id = String(d.id ?? "unknown");
    const kind = d.isUser ? "private" : d.isChannel ? "channel" : d.isGroup ? "group" : "other";
    const title = (d.title ?? d.name ?? "(no title)").slice(0, 40);
    console.log(`${id.padEnd(20)}  ${kind.padEnd(10)}  ${title}`);
  }

  console.log(
    "\nCopy the ids of chats you want to watch into runtime.allowlist in config.json (as strings).",
  );

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "failed to list chats");
  process.exit(1);
});
