import type { TelegramClient } from "telegram";
import type { Config } from "../config.js";
import { ask } from "../prompt.js";
import { logger } from "../logger.js";

export interface ReviewContext {
  chatId: string;
  chatTitle: string;
  incoming: string;
  draft: string;
  reason: string;
}

export type ReviewDecision = "sent" | "edited_sent" | "skipped";

export interface ReviewOutcome {
  decision: ReviewDecision;
  /** The text to actually send, present only for sent / edited_sent. */
  text?: string;
}

/**
 * Reviews are serialized through this queue so terminal prompts never
 * interleave when several messages arrive at once.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function banner(ctx: ReviewContext): string {
  return [
    "",
    "──────────────────────────────────────────────",
    `chat: ${ctx.chatTitle} (${ctx.chatId})`,
    `them: ${ctx.incoming}`,
    `draft: ${ctx.draft}`,
    `note: ${ctx.reason}`,
    "──────────────────────────────────────────────",
  ].join("\n");
}

/**
 * Present a draft for your approval. You always make the final call: send as-is,
 * edit then send, or skip. Nothing is sent from inside this function — it only
 * returns your decision and the text to send.
 */
export async function reviewDraft(
  client: TelegramClient,
  cfg: Config,
  ctx: ReviewContext,
): Promise<ReviewOutcome> {
  return serialize(async () => {
    if (cfg.runtime.delivery === "saved") {
      // Mirror the suggestion into Saved Messages for reference. The terminal
      // remains the control surface for the send/edit/skip decision.
      try {
        await client.sendMessage("me", { message: banner(ctx) });
      } catch (err) {
        logger.warn({ err }, "could not mirror draft to Saved Messages");
      }
    }

    console.log(banner(ctx));
    const choice = (await ask("[s]end  [e]dit  [k]skip > ")).toLowerCase();

    if (choice === "s" || choice === "send") {
      return { decision: "sent", text: ctx.draft };
    }
    if (choice === "e" || choice === "edit") {
      const edited = await ask("edited reply (blank to skip): ");
      if (!edited) return { decision: "skipped" };
      return { decision: "edited_sent", text: edited };
    }
    return { decision: "skipped" };
  });
}
