import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/** Prompt for a single line of input on the terminal. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompt without echoing the typed characters (for passwords / 2FA codes).
 * Falls back to a normal prompt when not attached to a TTY.
 */
export async function askHidden(question: string): Promise<string> {
  if (!input.isTTY) return ask(question);

  return new Promise<string>((resolve) => {
    output.write(question);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code === 3) {
          // Ctrl-C
          output.write("\n");
          process.exit(1);
        } else if (code === 13 || code === 10) {
          // Enter
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          resolve(buffer);
          return;
        } else if (code === 127 || code === 8) {
          // Backspace
          buffer = buffer.slice(0, -1);
        } else {
          buffer += ch;
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
