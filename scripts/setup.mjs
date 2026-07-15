// Cross-platform first-run setup. Interactively asks for your credentials and
// writes .env, so you don't have to edit files by hand. Also creates
// config.json from the example. Never overwrites a saved TELEGRAM_SESSION.
//
// When not attached to a terminal, it just copies the example files.
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function mask(v) {
  if (!v) return "";
  return v.length <= 6 ? "****" : `${v.slice(0, 3)}…${v.slice(-2)}`;
}

async function main() {
  // config.json (non-secret settings) — create from example if missing.
  if (!existsSync("config.json")) {
    copyFileSync("config.example.json", "config.json");
    console.log("created: config.json");
  }

  const existing = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};

  if (!stdin.isTTY) {
    if (!existsSync(".env")) {
      copyFileSync(".env.example", ".env");
      console.log("created: .env (edit it to add your keys)");
    }
    return;
  }

  console.log("\nПовторный запуск можно прервать (Ctrl+C). Enter — оставить текущее значение.\n");
  const rl = createInterface({ input: stdin, output: stdout });

  const askKeep = async (label, key) => {
    const cur = existing[key] ?? "";
    const hint = cur ? `оставить ${mask(cur)}` : "пусто";
    const ans = (await rl.question(`${label} [${hint}]: `)).trim();
    return ans || cur;
  };

  const apiId = await askKeep("Telegram API ID", "TELEGRAM_API_ID");
  const apiHash = await askKeep("Telegram API hash", "TELEGRAM_API_HASH");
  const geminiKey = await askKeep("Gemini API key", "GEMINI_API_KEY");
  rl.close();

  const env = {
    TELEGRAM_API_ID: apiId || "0",
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_SESSION: existing.TELEGRAM_SESSION ?? "",
    GEMINI_API_KEY: geminiKey,
    LOG_LEVEL: existing.LOG_LEVEL ?? "info",
  };
  writeFileSync(
    ".env",
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );

  console.log("\n.env сохранён.");
  const missing = [];
  if (!apiHash) missing.push("TELEGRAM_API_HASH");
  if (!geminiKey) missing.push("GEMINI_API_KEY");
  if (missing.length) {
    console.log(`Ещё не заполнено: ${missing.join(", ")} — запусти "npm run setup" ещё раз, когда получишь их.`);
  }

  console.log("\nДальше:");
  console.log("  1. npm run login   (вход в Telegram; сессия сохранится в .env сама)");
  console.log("  2. npm run chats   (узнать id чатов для allowlist)");
  console.log("  3. отредактируй config.json: self.userId и runtime.allowlist");
  console.log("  4. npm run build-persona -- путь\\к\\result.json");
  console.log("  5. npm start");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
