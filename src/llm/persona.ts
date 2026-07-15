import { readFileSync } from "node:fs";
import { z } from "zod";

export const PERSONA_VERSION = 1;

const WordCount = z.object({ word: z.string(), count: z.number() });
const PhraseCount = z.object({ phrase: z.string(), count: z.number() });

export const StyleMetricsSchema = z.object({
  messageCount: z.number(),
  avgLength: z.number(),
  medianLength: z.number(),
  emojiRate: z.number(),
  emojiMessageShare: z.number(),
  exclamationRate: z.number(),
  questionRate: z.number(),
  ellipsisRate: z.number(),
  allCapsShare: z.number(),
  lowercaseStartShare: z.number(),
  scriptMix: z.object({
    cyrillic: z.number(),
    latin: z.number(),
    mixed: z.number(),
  }),
  transliterationShare: z.number(),
  topWords: z.array(WordCount),
  topPhrases: z.array(PhraseCount),
});

export const FewShotSchema = z.object({ incoming: z.string(), reply: z.string() });

export const PersonaSchema = z.object({
  version: z.number(),
  generatedAt: z.string(),
  metrics: StyleMetricsSchema,
  systemPromptTemplate: z.string(),
  fewShot: z.array(FewShotSchema),
});

export type StyleMetrics = z.infer<typeof StyleMetricsSchema>;
export type FewShot = z.infer<typeof FewShotSchema>;
export type Persona = z.infer<typeof PersonaSchema>;

function validatePersona(raw: unknown, source: string): Persona {
  const persona = PersonaSchema.parse(raw);
  if (persona.version !== PERSONA_VERSION) {
    throw new Error(
      `persona (${source}) is version ${persona.version}, expected ${PERSONA_VERSION}. Rebuild it.`,
    );
  }
  return persona;
}

/** Load and validate persona.json. */
export function loadPersona(path: string): Persona {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read persona at ${path}. Run \`npm run build-persona\` first. (${(err as Error).message})`,
    );
  }
  return validatePersona(raw, path);
}

/**
 * Load the persona from the PERSONA_JSON environment variable (used when
 * deployed, e.g. on Railway) if set, otherwise from the file at `path`.
 */
export function loadPersonaFromEnvOrFile(path: string): Persona {
  const fromEnv = process.env.PERSONA_JSON;
  if (fromEnv && fromEnv.trim()) {
    return validatePersona(JSON.parse(fromEnv), "PERSONA_JSON env");
  }
  return loadPersona(path);
}
