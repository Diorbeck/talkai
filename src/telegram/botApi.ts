// Minimal Telegram Bot API client over fetch — no external dependency.
// Covers only the methods the co-pilot needs, including Business features
// (business_connection / business_message and sending on behalf of the user).

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  business_connection_id?: string;
}

export interface TgBusinessConnection {
  id: string;
  user: TgUser;
  user_chat_id: number;
  date: number;
  can_reply?: boolean;
  rights?: { can_reply?: boolean };
  is_enabled: boolean;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  business_connection?: TgBusinessConnection;
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

export const BUSINESS_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "business_connection",
  "business_message",
  "edited_business_message",
];

export class BotApi {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`${method} failed: ${data.description ?? "unknown error"}`);
    return data.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call("getMe", {});
  }

  getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: BUSINESS_ALLOWED_UPDATES,
    });
  }

  sendMessage(params: {
    chat_id: number | string;
    text: string;
    business_connection_id?: string;
    reply_markup?: { inline_keyboard: InlineKeyboard };
    reply_to_message_id?: number;
  }): Promise<TgMessage> {
    return this.call("sendMessage", params);
  }

  editMessageText(params: {
    chat_id: number | string;
    message_id: number;
    text: string;
    reply_markup?: { inline_keyboard: InlineKeyboard };
  }): Promise<unknown> {
    return this.call("editMessageText", params);
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown> {
    return this.call("setMyCommands", { commands });
  }
}

/** True when the business connection currently allows sending replies. */
export function canReply(conn: TgBusinessConnection): boolean {
  if (typeof conn.rights?.can_reply === "boolean") return conn.rights.can_reply;
  if (typeof conn.can_reply === "boolean") return conn.can_reply;
  return conn.is_enabled;
}
