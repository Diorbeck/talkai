import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { buildClient } from "./bot/client.js";
import { logger } from "./logger.js";

/** Write self.userId into config.json if it's still empty or the placeholder. */
function saveSelfId(userId: string): void {
  try {
    const cfg = JSON.parse(readFileSync("config.json", "utf8")) as {
      self?: { userId?: string };
    };
    const current = cfg.self?.userId ?? "";
    if (current && current !== "user000000000") return; // respect a value you set
    cfg.self = { ...(cfg.self ?? {}), userId: userId };
    writeFileSync("config.json", JSON.stringify(cfg, null, 2) + "\n");
    console.log(`\nYour account id was saved to config.json (self.userId = ${userId}).`);
  } catch (err) {
    logger.warn({ err }, "could not write self.userId to config.json");
  }
}

/**
 * List your Telegram dialogs with their ids, so you can fill
 * runtime.allowlist / denylist in config.json. Read-only: fetches the dialog
 * list and prints it, nothing else.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = await buildClient(cfg);

  const me = await client.getMe();
  if ("id" in me) saveSelfId(`user${me.id}`);

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
    "\nAdd a chat to the watch list without editing JSON, e.g.:  npm run watch -- <id>",
  );

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "failed to list chats");
  process.exit(1);
});
