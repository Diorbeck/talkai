import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Non-secret settings. Read from config.json when present; every field has a
 * default so the file is optional (e.g. when deployed on Railway with env vars).
 */
const ConfigFileSchema = z.object({
  self: z.object({ userId: z.string().default("") }).default({ userId: "" }),
  gemini: z
    .object({
      model: z.string().min(1).default("gemini-2.5-flash"),
      maxTokens: z.number().int().positive().max(8192).default(1024),
    })
    .default({}),
  persona: z.object({ path: z.string().min(1).default("persona.json") }).default({}),
  runtime: z
    .object({
      delivery: z.enum(["terminal", "saved"]).default("terminal"),
      allowlist: z.array(z.string()).default([]),
      denylist: z.array(z.string()).default([]),
      activeHours: z
        .object({
          start: z.string().regex(HHMM, "expected HH:MM").default("00:00"),
          end: z.string().regex(HHMM, "expected HH:MM").default("23:59"),
          timezone: z.string().min(1).default(process.env.TZ ?? "UTC"),
        })
        .default({}),
      rateLimit: z
        .object({
          perChatPerHour: z.number().int().positive().default(8),
          globalPerHour: z.number().int().positive().default(40),
        })
        .default({}),
      killSwitchFile: z.string().min(1).default("KILL"),
      dbPath: z.string().min(1).default("suggestions.db"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigFileSchema> & {
  telegram: { apiId: number; apiHash: string; session: string };
};

const EnvSchema = z.object({
  // Only needed for the legacy MTProto mode (npm run start:mtproto / login).
  TELEGRAM_API_ID: z.coerce.number().int().optional().default(0),
  TELEGRAM_API_HASH: z.string().optional().default(""),
  TELEGRAM_SESSION: z.string().default(""),
  GEMINI_API_KEY: z.string().min(1).optional(),
  BOT_TOKEN: z.string().optional(),
});

/**
 * Load and validate config.json plus the required environment variables.
 * Secrets live only in the environment; config.json holds behaviour settings.
 */
export function loadConfig(path = "config.json"): Config {
  const abs = resolve(process.cwd(), path);
  let raw: unknown = {};
  if (existsSync(abs)) {
    try {
      raw = JSON.parse(readFileSync(abs, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse ${abs}: ${(err as Error).message}`);
    }
  }

  const file = ConfigFileSchema.parse(raw);
  const env = EnvSchema.parse(process.env);

  return {
    ...file,
    telegram: {
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      session: env.TELEGRAM_SESSION,
    },
  };
}

/** Env-only accessors for the login flow, which runs before config.json is needed. */
export function loadTelegramEnv(): { apiId: number; apiHash: string; session: string } {
  const env = EnvSchema.parse(process.env);
  return {
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    session: env.TELEGRAM_SESSION,
  };
}
