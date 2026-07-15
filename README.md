# talkai

A Telegram MTProto tool that learns your personal writing style from a chat-history export and drafts on-style replies for **you to review and send**.

You remain the author. Every send is your decision — the co-pilot only ever
proposes a draft; it never sends anything on its own.

## What it does

1. **Analyzer** — reads a Telegram Desktop chat export, extracts your messages
   and `(incoming → your reply)` pairs, and builds a style profile in
   `persona.json`: length habits, emoji and punctuation rates, script and
   ru/uz language mixing, and your characteristic words and phrases. Contact
   PII (emails, phones, links, handles, names) is redacted from the stored
   examples.
2. **Reply co-pilot** — signs into your own Telegram account, watches an
   explicit allowlist of chats, drafts a candidate reply in your voice via the
   Gemini API, and shows it to you to **send / edit / skip**. Includes a
   prompt-injection guard, a rule to stay silent on uncertain or sensitive
   topics, active-hours gating, rate limits, a kill switch, and SQLite logging
   of every suggestion.

## Stack

Node.js 22+, TypeScript (strict, ESM), GramJS (`telegram`),
 `zod`, `dotenv`, `better-sqlite3`, `pino`.

## Setup

```bash
npm install
npm run setup    # interactively asks for your keys and writes .env + config.json
```

`npm run setup` prompts for `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and
`GEMINI_API_KEY` and writes them to `.env` for you — no manual file editing,
same on Windows, macOS, and Linux. Press Enter at a prompt to keep the current
value. Re-run it any time to change a key.

Get the values here:

- Telegram `api_id` / `api_hash`: <https://my.telegram.org> → *API development tools*.
- Gemini API key: <https://aistudio.google.com/apikey>.

> **Windows / cmd note:** don't paste inline `# comments` after a command —
> cmd treats them as arguments.

### 1. Log in (one time)

```bash
npm run login
```

Enter your phone, the login code, and 2FA password if you have one. The session
string is saved to `.env` automatically. It grants full access to your account;
keep `.env` secret.

### 2. Build your persona (Phases 1–2: the analyzer)

Export a chat history from Telegram Desktop
(*Settings → Advanced → Export Telegram data*, JSON format), then:

```bash
# self user id is read from config.json (self.userId), e.g. "user123456789"
npm run build-persona -- path/to/result.json
```

This writes `persona.json`. Inspect a quick summary of an export first with:

```bash
npm run parse -- path/to/result.json user123456789
```

Find your own `from_id` by searching the export JSON for one of your messages.

### 3. Run the co-pilot

Edit `config.json`:

- `self.userId` — your Telegram user id.
- `runtime.allowlist` — chat ids you opt into watching. **Empty means nothing
  is watched** (default-deny). List your chats and their ids with:

  ```bash
  npm run chats
  ```

- `runtime.activeHours` / `rateLimit` / `delivery` — see below.

Then:

```bash
npm start
```

Incoming messages in allowlisted chats produce a draft in your terminal. Choose
`s` to send as-is, `e` to edit then send, or `k` to skip.

## Deploy to Railway (run 24/7 without your terminal)

The Telegram Business bot can run on [Railway](https://railway.app) so it works
even when your computer is off.

1. **Push the repo to GitHub** (already done for this branch).
2. On Railway: **New Project → Deploy from GitHub repo →** pick this repo and
   the `claude/telegram-persona-reply-copilot-edat7u` branch.
3. **Add a Volume** (Railway → your service → *Volumes* → mount at `/data`).
   This keeps `state.json` (your connection + per-chat settings) and the
   SQLite log across redeploys.
4. **Set Variables** (Railway → *Variables*):
   - `BOT_TOKEN` — your @BotFather token
   - `GEMINI_API_KEY` — your Gemini key
   - `DATA_DIR` — `/data` (the volume mount path)
   - `PERSONA_JSON` — the full contents of your local `persona.json`
     (on Windows, run `type persona.json | clip` to copy it, then paste)
   - optionally `TZ` — e.g. `Asia/Tashkent` for active-hours
5. Railway builds and starts it (`npm start`). Check the deploy logs for
   `control bot ready`.
6. **Connect the bot once more from the app** so the connection is captured on
   the server: Telegram → *Settings → Telegram Business → Chatbots* → toggle
   your bot off and on. The bot chat should say `✅ Подключено`.
7. **Stop the local `npm start`** — only one instance may poll Telegram at a
   time (two cause a `409 Conflict`).

`config.json` is optional on Railway — defaults apply, and `PERSONA_JSON`
replaces the persona file. Update the persona later by rebuilding it locally
and pasting the new `persona.json` into `PERSONA_JSON`.

## Configuration (`config.json`)

| Field | Meaning |
| --- | --- |
| `self.userId` | Your Telegram user id (`user…`), used to identify your messages in the export. |
| `gemini.model` | Gemini model for drafting (default `gemini-2.5-flash`). |
| `gemini.maxTokens` | Max tokens per draft. |
| `runtime.delivery` | `terminal` (prompt in the terminal) or `saved` (also mirror drafts into Saved Messages; the terminal stays the control surface). |
| `runtime.allowlist` / `denylist` | Chat ids to watch / never watch. |
| `runtime.activeHours` | `start`/`end` (`HH:MM`) and IANA `timezone`; outside this window nothing is drafted. |
| `runtime.rateLimit` | `perChatPerHour` and `globalPerHour` caps on sends. |
| `runtime.killSwitchFile` | Create this file to halt all activity immediately. |
| `runtime.dbPath` | SQLite log of suggestions and decisions. |

Secrets live only in `.env` (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_SESSION`, `GEMINI_API_KEY`). `.env`, `config.json`, `persona.json`,
the SQLite DB, and exports are all gitignored.

## Safety model

- **You send, not the bot.** Drafts are proposals; sending requires your choice.
- **Default-deny.** No chat is watched until you add it to the allowlist.
- **Stay silent when unsure.** The model declines on sensitive, uncertain, or
  emotionally weighty messages (`should_reply: false`).
- **Prompt-injection guard.** Incoming messages and context are treated as
  untrusted data; instructions inside them are never obeyed.
- **Kill switch.** `touch KILL` (or your configured file) stops everything.
- **Rate limits + active hours.** Bound how much and when anything can be sent.
- **Audit log.** Every suggestion and decision is written to SQLite.

## Components

| Module | Role |
| --- | --- |
| `src/login.ts` | One-time interactive login; saves the session to `.env`. |
| `src/chats.ts` | Lists your dialogs with ids (for the allowlist). |
| `src/config.ts` | zod-validated `config.json` + `.env` loader. |
| `src/parser/parseExport.ts` | Parses the export, extracts pairs, redacts PII. |
| `src/parser/buildPersona.ts` | Computes style metrics; emits `persona.json`. |
| `src/llm/persona.ts` | Persona types and loader. |
| `src/llm/generate.ts` | Assembles the prompt, calls Gemini, returns a draft or `null`. |
| `src/bot/client.ts` | Builds the `TelegramClient` from the session string. |
| `src/bot/handler.ts` | `NewMessage` handler: safety filters → context → draft → review. |
| `src/bot/review.ts` | Delivers the draft to you for approval. |
| `src/bot/safety.ts` | Allowlist/denylist, rate limit, kill switch, active hours. |
| `src/db.ts` | SQLite logging of every suggestion. |
| `src/index.ts` | Entry point + graceful shutdown. |

## Scripts

```bash
npm run setup          # create .env + config.json from examples
npm run login          # one-time Telegram login
npm run chats          # list your chats + ids (for the allowlist)
npm run parse -- <f>   # summarize an export
npm run build-persona -- <f>   # build persona.json
npm start              # run the reply co-pilot
npm run typecheck      # tsc --noEmit
npm run build          # compile to dist/
```
