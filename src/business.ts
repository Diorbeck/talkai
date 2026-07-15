import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "./config.js";
import { loadPersonaFromEnvOrFile } from "./llm/persona.js";
import { SuggestionStore } from "./db.js";
import { SafetyGate } from "./bot/safety.js";
import { Store } from "./store.js";
import { generateDraft } from "./llm/generate.js";
import {
  BotApi,
  canReply,
  type TgUpdate,
  type TgMessage,
  type TgCallbackQuery,
  type TgBusinessConnection,
  type TgChat,
  type InlineKeyboard,
} from "./telegram/botApi.js";
import { logger } from "./logger.js";

interface Pending {
  connectionId: string;
  targetChatId: number;
  chatId: string;
  chatTitle: string;
  incoming: string;
  draft: string;
  reason: string;
}

function chatTitleOf(chat: TgChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  if (name) return name;
  if (chat.username) return `@${chat.username}`;
  return String(chat.id);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set. Run `npm run setup` or add it to your .env.");
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set (npm run setup).");

  // Persist settings + the SQLite log on a mounted volume so they survive
  // redeploys. Prefer an explicit DATA_DIR; otherwise auto-detect Railway's
  // volume mount path; fall back to the working directory locally.
  const dataDir = process.env.DATA_DIR ?? process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".";
  const dbPath = isAbsolute(cfg.runtime.dbPath) ? cfg.runtime.dbPath : join(dataDir, cfg.runtime.dbPath);
  logger.info({ dataDir }, "using data directory");

  const persona = loadPersonaFromEnvOrFile(cfg.persona.path);
  const suggestions = new SuggestionStore(dbPath);
  const gate = new SafetyGate(cfg, suggestions);
  const store = new Store(join(dataDir, "state.json"));
  const api = new BotApi(token);

  // Health server so hosts like Railway see the worker as up (they set PORT).
  const port = process.env.PORT;
  if (port) {
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }).listen(Number(port), () => logger.info({ port }, "health server listening"));
  }

  const me = await api.getMe();
  logger.info({ bot: me.username }, "control bot ready");
  await api.setMyCommands([
    { command: "start", description: "How to connect and use the co-pilot" },
    { command: "chats", description: "Toggle chats and set per-chat prompts" },
    { command: "status", description: "Connection and settings status" },
    { command: "help", description: "Help" },
  ]);

  const pending = new Map<string, Pending>();
  const awaitingEdit = new Map<number, string>(); // adminChatId -> pendingId
  const awaitingPrompt = new Map<number, string>(); // adminChatId -> chatId
  let counter = 0;

  const adminChatId = (): number | undefined => store.getConnection()?.userChatId;
  const isAdmin = (userId: number | undefined): boolean => {
    const conn = store.getConnection();
    if (!conn) return true; // before connecting, allow /start
    return userId === conn.userId;
  };

  const notifyAdmin = async (text: string, keyboard?: InlineKeyboard): Promise<TgMessage | null> => {
    const chatId = adminChatId();
    if (!chatId) return null;
    try {
      return await api.sendMessage({
        chat_id: chatId,
        text,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (err) {
      logger.warn({ err }, "could not message admin");
      return null;
    }
  };

  // ---- Business connection ----
  const onConnection = async (conn: TgBusinessConnection): Promise<void> => {
    if (conn.is_enabled) {
      store.setConnection({ id: conn.id, userId: conn.user.id, userChatId: conn.user_chat_id });
      const can = canReply(conn);
      await api.sendMessage({
        chat_id: conn.user_chat_id,
        text: can
          ? "✅ Подключено. Я буду присылать черновики ответов на входящие. Команда /chats — включить нужные чаты и задать промпт."
          : "⚠️ Подключено, но у меня нет прав на отправку сообщений. В настройках Telegram для бизнеса разреши боту отвечать.",
      });
    } else {
      const prev = store.getConnection();
      store.setConnection(undefined);
      if (prev) {
        await api.sendMessage({ chat_id: prev.userChatId, text: "🔌 Отключено от аккаунта." }).catch(() => {});
      }
    }
  };

  // ---- Incoming business message (a contact wrote to the user) ----
  let warnedNoConn = false;
  const onBusinessMessage = async (msg: TgMessage): Promise<void> => {
    const conn = store.getConnection();
    if (!conn) {
      if (!warnedNoConn) {
        warnedNoConn = true;
        logger.warn(
          "received a business message but no connection is stored — reconnect the bot in Telegram Business settings (toggle it off and on). Set DATA_DIR to a mounted volume so this survives redeploys.",
        );
      }
      return;
    }
    if (!msg.business_connection_id) return;
    if (msg.from?.id === conn.userId) return; // the user's own outgoing message
    const incoming = msg.text?.trim();
    if (!incoming) return;

    const chatId = String(msg.chat.id);
    const title = chatTitleOf(msg.chat);
    const { created, chat } = store.ensureChat(chatId, title);

    if (created) {
      await notifyAdmin(`✉️ Новый чат «${title}» написал тебе. Включить черновики для него?`, [
        [{ text: "✅ Включить", callback_data: `en:${chatId}` }],
      ]);
      return;
    }
    if (!chat.enabled) return;
    if (gate.isKilled() || !gate.isActiveNow()) return;

    const result = await generateDraft(cfg, persona, {
      incoming,
      context: [],
      perChatPrompt: chat.prompt,
    });

    const base = {
      ts: Date.now(),
      chat_id: chatId,
      chat_title: title,
      incoming_text: incoming,
      draft: result.draft,
      reason: result.reason,
      model: cfg.gemini.model,
    };

    if (result.draft === null) {
      suggestions.record({ ...base, decision: "suppressed", sent_text: null });
      await notifyAdmin(`🤫 Не ответил в «${title}»: ${result.reason}\nИм: ${incoming}`);
      return;
    }

    // Auto mode: send the draft directly, still respecting rate limits, and
    // tell the admin what went out so they can course-correct.
    if (chat.auto) {
      const g = gate.canSend(chatId);
      if (!g.ok) {
        suggestions.record({ ...base, decision: "suppressed", sent_text: null });
        return;
      }
      try {
        await api.sendMessage({
          chat_id: msg.chat.id,
          text: result.draft,
          business_connection_id: conn.id,
        });
        suggestions.record({ ...base, decision: "sent", sent_text: result.draft });
        await notifyAdmin(`🤖 Авто-ответ → ${title}\nИм: ${incoming}\nОтвет: ${result.draft}`);
      } catch (err) {
        logger.error({ err }, "auto-send failed");
        await notifyAdmin("⚠️ Авто-ответ не отправился (проверь права бота).");
      }
      return;
    }

    const pid = String(++counter);
    pending.set(pid, {
      connectionId: conn.id,
      targetChatId: msg.chat.id,
      chatId,
      chatTitle: title,
      incoming,
      draft: result.draft,
      reason: result.reason,
    });

    await notifyAdmin(
      `💬 ${title}\nОни: ${incoming}\n\nЧерновик: ${result.draft}`,
      [
        [{ text: "✅ Отправить", callback_data: `s:${pid}` }],
        [
          { text: "✏️ Править", callback_data: `e:${pid}` },
          { text: "⏭ Пропустить", callback_data: `k:${pid}` },
        ],
      ],
    );
  };

  const send = async (p: Pending, text: string, decision: "sent" | "edited_sent"): Promise<boolean> => {
    const g = gate.canSend(p.chatId);
    if (!g.ok) {
      await notifyAdmin(`⚠️ Не отправлено (${g.reason}).`);
      return false;
    }
    try {
      await api.sendMessage({
        chat_id: p.targetChatId,
        text,
        business_connection_id: p.connectionId,
      });
      suggestions.record({
        ts: Date.now(),
        chat_id: p.chatId,
        chat_title: p.chatTitle,
        incoming_text: p.incoming,
        draft: p.draft,
        reason: p.reason,
        decision,
        sent_text: text,
        model: cfg.gemini.model,
      });
      return true;
    } catch (err) {
      logger.error({ err }, "failed to send reply on behalf of user");
      await notifyAdmin("⚠️ Ошибка отправки. Проверь, что у бота есть права отвечать.");
      return false;
    }
  };

  // ---- Callback buttons ----
  const onCallback = async (cb: TgCallbackQuery): Promise<void> => {
    if (!isAdmin(cb.from.id)) {
      await api.answerCallbackQuery(cb.id);
      return;
    }
    const data = cb.data ?? "";
    const [action, arg] = [data.slice(0, data.indexOf(":")), data.slice(data.indexOf(":") + 1)];
    const editMsg = cb.message;

    const replaceMarkup = async (text: string): Promise<void> => {
      if (!editMsg) return;
      await api.editMessageText({ chat_id: editMsg.chat.id, message_id: editMsg.message_id, text }).catch(() => {});
    };

    switch (action) {
      case "s": {
        const p = pending.get(arg);
        if (!p) return void (await api.answerCallbackQuery(cb.id, "Устарело"));
        const ok = await send(p, p.draft, "sent");
        pending.delete(arg);
        await api.answerCallbackQuery(cb.id, ok ? "Отправлено" : "Не отправлено");
        if (ok) await replaceMarkup(`✅ Отправлено → ${p.chatTitle}\n${p.draft}`);
        break;
      }
      case "e": {
        const p = pending.get(arg);
        if (!p) return void (await api.answerCallbackQuery(cb.id, "Устарело"));
        awaitingEdit.set(cb.from.id, arg);
        await api.answerCallbackQuery(cb.id);
        await notifyAdmin(`✏️ Пришли исправленный ответ для «${p.chatTitle}» одним сообщением.`);
        break;
      }
      case "k": {
        const p = pending.get(arg);
        if (p) {
          suggestions.record({
            ts: Date.now(),
            chat_id: p.chatId,
            chat_title: p.chatTitle,
            incoming_text: p.incoming,
            draft: p.draft,
            reason: p.reason,
            decision: "skipped",
            sent_text: null,
            model: cfg.gemini.model,
          });
        }
        pending.delete(arg);
        await api.answerCallbackQuery(cb.id, "Пропущено");
        if (p) await replaceMarkup(`⏭ Пропущено — ${p.chatTitle}`);
        break;
      }
      case "en": {
        store.ensureChat(arg, "");
        store.setEnabled(arg, true);
        await api.answerCallbackQuery(cb.id, "Включено");
        await replaceMarkup(`🟢 Чат включён. Теперь я буду присылать черновики.`);
        break;
      }
      case "tg": {
        const chat = store.getChat(arg);
        if (chat) store.setEnabled(arg, !chat.enabled);
        await api.answerCallbackQuery(cb.id, chat && !chat.enabled ? "Включено" : "Выключено");
        await sendChatsList(cb.from.id, editMsg?.message_id);
        break;
      }
      case "au": {
        const chat = store.getChat(arg);
        const next = !(chat?.auto ?? false);
        if (chat) store.setAuto(arg, next);
        await api.answerCallbackQuery(
          cb.id,
          next ? "Авто-режим: бот будет отвечать сам" : "Ручной режим: черновик с кнопками",
        );
        await sendChatsList(cb.from.id, editMsg?.message_id);
        break;
      }
      case "pr": {
        const chat = store.getChat(arg);
        awaitingPrompt.set(cb.from.id, arg);
        await api.answerCallbackQuery(cb.id);
        await notifyAdmin(
          `✍️ Пришли промпт для «${chat?.title ?? arg}» одним сообщением (например: «отвечай коротко и вежливо»). Отправь «-», чтобы убрать промпт.`,
        );
        break;
      }
      default:
        await api.answerCallbackQuery(cb.id);
    }
  };

  const sendChatsList = async (chatId: number, editMessageId?: number): Promise<void> => {
    const chats = store.listChats();
    const text = chats.length
      ? "Твои чаты.\n🟢/⚪ — следить за чатом.\n🤖 авто — отвечает сам, 🖐 вручную — присылает черновик с кнопками.\n✏️ — промпт для чата (✏️* = задан)."
      : "Пока нет известных чатов. Как только тебе кто-то напишет, чат появится здесь.";
    const keyboard: InlineKeyboard = chats.map(({ chatId: id, settings }) => [
      { text: `${settings.enabled ? "🟢" : "⚪"} ${settings.title}`.slice(0, 40), callback_data: `tg:${id}` },
      { text: settings.auto ? "🤖 авто" : "🖐 вручную", callback_data: `au:${id}` },
      { text: settings.prompt ? "✏️*" : "✏️", callback_data: `pr:${id}` },
    ]);
    if (editMessageId) {
      await api
        .editMessageText({ chat_id: chatId, message_id: editMessageId, text, reply_markup: { inline_keyboard: keyboard } })
        .catch(() => {});
    } else {
      await api.sendMessage({ chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } });
    }
  };

  // ---- Messages the user sends to the bot directly ----
  const onAdminMessage = async (msg: TgMessage): Promise<void> => {
    if (msg.business_connection_id) return; // handled as business message
    const from = msg.from?.id;
    if (!isAdmin(from)) return;
    const text = msg.text?.trim();
    if (!text || !from) return;

    if (awaitingPrompt.has(from)) {
      const chatId = awaitingPrompt.get(from)!;
      awaitingPrompt.delete(from);
      store.setPrompt(chatId, text === "-" ? undefined : text);
      await api.sendMessage({ chat_id: msg.chat.id, text: text === "-" ? "Промпт убран." : "Промпт сохранён." });
      return;
    }
    if (awaitingEdit.has(from)) {
      const pid = awaitingEdit.get(from)!;
      awaitingEdit.delete(from);
      const p = pending.get(pid);
      if (!p) return void (await api.sendMessage({ chat_id: msg.chat.id, text: "Черновик устарел." }));
      const ok = await send(p, text, "edited_sent");
      pending.delete(pid);
      await api.sendMessage({ chat_id: msg.chat.id, text: ok ? `✅ Отправлено → ${p.chatTitle}` : "Не отправлено." });
      return;
    }

    if (text.startsWith("/start")) {
      await api.sendMessage({
        chat_id: msg.chat.id,
        text:
          "Привет! Я черновлю ответы в твоём стиле, а ты отправляешь их одной кнопкой.\n\n" +
          "Чтобы я видел входящие: Настройки → Telegram для бизнеса → Чат-боты → выбери меня и разреши отвечать.\n\n" +
          "Потом /chats — включи нужные чаты и задай промпт для каждого.",
      });
      return;
    }
    if (text.startsWith("/chats")) {
      await sendChatsList(msg.chat.id);
      return;
    }
    if (text.startsWith("/status")) {
      const conn = store.getConnection();
      const on = store.listChats().filter((c) => c.settings.enabled).length;
      await api.sendMessage({
        chat_id: msg.chat.id,
        text: `Подключение: ${conn ? "активно ✅" : "нет ❌"}\nВключено чатов: ${on}\nАктивные часы: ${cfg.runtime.activeHours.start}–${cfg.runtime.activeHours.end} (${cfg.runtime.activeHours.timezone})`,
      });
      return;
    }
    if (text.startsWith("/help")) {
      await api.sendMessage({
        chat_id: msg.chat.id,
        text:
          "Команды: /chats — чаты, режим и промпты; /status — статус.\n" +
          "В /chats для каждого чата: 🟢/⚪ следить, 🤖 авто / 🖐 вручную, ✏️ промпт.\n" +
          "🖐 вручную — черновик с кнопками Отправить/Править/Пропустить. 🤖 авто — бот отвечает сам (на сомнительных сообщениях всё равно молчит).",
      });
      return;
    }
  };

  const dispatch = async (u: TgUpdate): Promise<void> => {
    try {
      if (u.business_connection) await onConnection(u.business_connection);
      else if (u.business_message) await onBusinessMessage(u.business_message);
      else if (u.callback_query) await onCallback(u.callback_query);
      else if (u.message) await onAdminMessage(u.message);
    } catch (err) {
      logger.error({ err, update_id: u.update_id }, "error handling update");
    }
  };

  let running = true;
  let offset = 0;
  logger.info(
    { activeHours: cfg.runtime.activeHours, killSwitch: cfg.runtime.killSwitchFile },
    "co-pilot running — connect the bot in Telegram Business settings, then /chats",
  );

  const shutdown = (sig: string) => {
    logger.info({ sig }, "shutting down");
    running = false;
    suggestions.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (running) {
    try {
      const updates = await api.getUpdates(offset);
      for (const u of updates) {
        offset = u.update_id + 1;
        await dispatch(u);
      }
    } catch (err) {
      logger.warn({ err }, "getUpdates failed; retrying");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
