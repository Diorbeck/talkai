import Database from "better-sqlite3";

export type Decision = "sent" | "edited_sent" | "skipped" | "suppressed";

export interface SuggestionRow {
  id: number;
  ts: number;
  chat_id: string;
  chat_title: string | null;
  incoming_text: string;
  draft: string | null;
  reason: string | null;
  decision: Decision;
  sent_text: string | null;
  model: string | null;
}

/**
 * SQLite log of every suggestion the co-pilot produces and every decision you
 * make about it. Append-only; useful for auditing and for tuning the persona.
 */
export class SuggestionStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        chat_id       TEXT    NOT NULL,
        chat_title    TEXT,
        incoming_text TEXT    NOT NULL,
        draft         TEXT,
        reason        TEXT,
        decision      TEXT    NOT NULL,
        sent_text     TEXT,
        model         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_suggestions_chat_ts
        ON suggestions (chat_id, ts);
    `);
  }

  record(entry: Omit<SuggestionRow, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO suggestions
        (ts, chat_id, chat_title, incoming_text, draft, reason, decision, sent_text, model)
      VALUES
        (@ts, @chat_id, @chat_title, @incoming_text, @draft, @reason, @decision, @sent_text, @model)
    `);
    const info = stmt.run(entry);
    return Number(info.lastInsertRowid);
  }

  /** Count decisions that resulted in an outbound message, for rate limiting. */
  countSentSince(chatId: string | null, sinceTs: number): number {
    const sent = ["sent", "edited_sent"];
    const placeholders = sent.map(() => "?").join(",");
    if (chatId === null) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM suggestions
           WHERE ts >= ? AND decision IN (${placeholders})`,
        )
        .get(sinceTs, ...sent) as { n: number };
      return row.n;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM suggestions
         WHERE chat_id = ? AND ts >= ? AND decision IN (${placeholders})`,
      )
      .get(chatId, sinceTs, ...sent) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
