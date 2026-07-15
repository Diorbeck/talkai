import { NewMessage } from "telegram/events/index.js";
import { loadConfig } from "./config.js";
import { loadPersona } from "./llm/persona.js";
import { SuggestionStore } from "./db.js";
import { buildClient } from "./bot/client.js";
import { SafetyGate } from "./bot/safety.js";
import { makeHandler } from "./bot/handler.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Run `npm run setup` or add it to your .env.");
  }

  const persona = loadPersona(cfg.persona.path);
  const store = new SuggestionStore(cfg.runtime.dbPath);
  const client = await buildClient(cfg);
  const gate = new SafetyGate(cfg, store);

  const handler = makeHandler({ client, cfg, persona, store, gate });
  client.addEventHandler(handler, new NewMessage({}));

  logger.info(
    {
      allowlist: cfg.runtime.allowlist,
      delivery: cfg.runtime.delivery,
      activeHours: cfg.runtime.activeHours,
      killSwitch: cfg.runtime.killSwitchFile,
    },
    "reply co-pilot running — drafts are shown for your review, nothing sends automatically",
  );
  if (cfg.runtime.allowlist.length === 0) {
    logger.warn(
      "allowlist is empty: no chats are watched. Add chat ids to runtime.allowlist in config.json.",
    );
  }
  console.log(
    `Create the file "${cfg.runtime.killSwitchFile}" at any time to halt all activity. Press Ctrl-C to stop.`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    try {
      client.removeEventHandler(handler, new NewMessage({}));
      await client.disconnect();
    } catch (err) {
      logger.warn({ err }, "error during disconnect");
    }
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
