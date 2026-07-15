import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * Add (or with --remove, drop) chat ids in runtime.allowlist of config.json,
 * so you don't have to edit the JSON by hand.
 *
 *   npm run watch -- 376665750 677485709
 *   npm run watch -- --remove 376665750
 *   npm run watch                       (just prints the current allowlist)
 */
function main(): void {
  if (!existsSync("config.json")) {
    console.error("config.json not found. Run `npm run setup` first.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const ids = args.filter((a) => a !== "--remove").map((a) => a.trim()).filter(Boolean);

  const cfg = JSON.parse(readFileSync("config.json", "utf8")) as {
    runtime?: { allowlist?: string[] };
  };
  cfg.runtime ??= {};
  const current = new Set(cfg.runtime.allowlist ?? []);

  for (const id of ids) {
    if (remove) current.delete(id);
    else current.add(id);
  }
  cfg.runtime.allowlist = [...current];

  writeFileSync("config.json", JSON.stringify(cfg, null, 2) + "\n");

  console.log(`Watched chats (runtime.allowlist): ${cfg.runtime.allowlist.length ? cfg.runtime.allowlist.join(", ") : "(none)"}`);
  if (ids.length === 0 && !remove) {
    console.log("Add chats with:  npm run watch -- <chatId> [<chatId> ...]");
  }
}

main();
