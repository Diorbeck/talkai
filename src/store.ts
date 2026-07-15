import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ChatSettings {
  title: string;
  enabled: boolean;
  /** When true, approved-style drafts are sent automatically (no button). */
  auto?: boolean;
  prompt?: string;
}

export interface ConnectionState {
  id: string;
  userId: number;
  userChatId: number;
}

interface StateFile {
  connection?: ConnectionState;
  chats: Record<string, ChatSettings>;
}

/**
 * Persistent per-chat settings (enabled + custom prompt) and the current
 * Telegram Business connection, saved to a JSON file. Edited from the bot.
 */
export class Store {
  private state: StateFile = { chats: {} };

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
        this.state = { chats: parsed.chats ?? {}, ...(parsed.connection ? { connection: parsed.connection } : {}) };
      } catch {
        this.state = { chats: {} };
      }
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2) + "\n");
  }

  getConnection(): ConnectionState | undefined {
    return this.state.connection;
  }

  setConnection(conn: ConnectionState | undefined): void {
    this.state.connection = conn;
    this.save();
  }

  getChat(chatId: string): ChatSettings | undefined {
    return this.state.chats[chatId];
  }

  /** Register a chat we've seen, defaulting to disabled (opt-in per chat). */
  ensureChat(chatId: string, title: string): { created: boolean; chat: ChatSettings } {
    const existing = this.state.chats[chatId];
    if (existing) {
      if (title && existing.title !== title) {
        existing.title = title;
        this.save();
      }
      return { created: false, chat: existing };
    }
    const chat: ChatSettings = { title: title || chatId, enabled: false };
    this.state.chats[chatId] = chat;
    this.save();
    return { created: true, chat };
  }

  setEnabled(chatId: string, enabled: boolean): void {
    const chat = this.state.chats[chatId];
    if (chat) {
      chat.enabled = enabled;
      this.save();
    }
  }

  setAuto(chatId: string, auto: boolean): void {
    const chat = this.state.chats[chatId];
    if (chat) {
      chat.auto = auto;
      this.save();
    }
  }

  setPrompt(chatId: string, prompt: string | undefined): void {
    const chat = this.state.chats[chatId];
    if (chat) {
      if (prompt && prompt.trim()) chat.prompt = prompt.trim();
      else delete chat.prompt;
      this.save();
    }
  }

  listChats(): { chatId: string; settings: ChatSettings }[] {
    return Object.entries(this.state.chats).map(([chatId, settings]) => ({ chatId, settings }));
  }
}
