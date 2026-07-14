// Cross-platform first-run setup: create .env and config.json from the
// examples if they don't exist yet. Safe to run repeatedly — never overwrites.
import { existsSync, copyFileSync } from "node:fs";

const pairs = [
  [".env.example", ".env"],
  ["config.example.json", "config.json"],
];

let created = 0;
for (const [src, dest] of pairs) {
  if (existsSync(dest)) {
    console.log(`skip: ${dest} already exists`);
    continue;
  }
  copyFileSync(src, dest);
  console.log(`created: ${dest}`);
  created += 1;
}

if (created > 0) {
  console.log("\nNext:");
  console.log("  1. Edit .env  — TELEGRAM_API_ID, TELEGRAM_API_HASH, ANTHROPIC_API_KEY");
  console.log("  2. Edit config.json — self.userId, runtime.allowlist");
  console.log("  3. npm run login   (then paste TELEGRAM_SESSION into .env)");
  console.log("  4. npm run build-persona -- path\\to\\result.json");
  console.log("  5. npm run chats   (find chat ids for the allowlist)");
  console.log("  6. npm start");
}
