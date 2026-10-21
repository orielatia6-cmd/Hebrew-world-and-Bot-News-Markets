import { eq } from "drizzle-orm";
import { db, briefingSettingsTable } from "@workspace/db";
import { logger } from "../logger";
import { redactBotToken } from "./secret-safety";
import { ensureBriefingSettings } from "./store";
import { scheduleHebrew } from "./schedule";

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramUser = {
  username?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string };
  };
};

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

async function telegramCall<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method.split("?")[0] === "getUpdates" ? 35_000 : 15_000),
  });

  const payload = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description || `Telegram ${method} request failed.`);
  }
  return payload.result;
}

export async function getTelegramBotUsername(): Promise<string | null> {
  if (!botToken()) return null;
  await ensureBriefingSettings();
  const user = await telegramCall<TelegramUser>("getMe");
  const username = user.username ?? null;
  if (username) {
    await db
      .update(briefingSettingsTable)
      .set({ botUsername: username })
      .where(eq(briefingSettingsTable.id, 1));
  }
  return username;
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendHebrew(chatId: string, text: string): Promise<void> {
  try {
    await sendTelegramMessage(chatId, text);
  } catch (error) {
    const reason = redactBotToken(error instanceof Error ? error.message : "Unknown Telegram error");
    logger.warn({ reason }, "Telegram message could not be delivered");
  }
}

function formatTime(value: Date | null): string {
  if (!value) return "עדיין לא בוצעה בדיקה";
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

function welcomeText(): string {
  return [
    "Briefline מחובר. אשלח לך תדרוכי חדשות חשובים בעברית.",
    "",
    `מקורות נבדקים בכל עדכון מתוזמן. ארבעה תדרוכים ביום: ${scheduleHebrew()}. ידיעות חריגות נבדקות גם בזמן התדרוכים.`,
    "",
    "פקודות:",
    "/status — מצב ותדירות",
    "/schedule — זמני התדרוכים וההתראות",
    "/importance 3|4|5 — רף חשיבות מינימלי",
    "/pause — השהיית עדכונים",
    "/resume — הפעלת עדכונים",
    "/refresh — בדיקה ידנית של חדשות",
    "/test — שליחת הודעת בדיקה",
    "/help — הצגת העזרה",
  ].join("\n");
}

async function handleStart(chatId: string): Promise<void> {
  const settings = await ensureBriefingSettings();
  if (settings.telegramChatId && settings.telegramChatId !== chatId) {
    await sendHebrew(
      chatId,
      "הבוט כבר מחובר לחשבון אחר ולא ניתן לחבר צ׳אט נוסף.",
    );
    return;
  }

  if (!settings.telegramChatId) {
    await db
      .update(briefingSettingsTable)
      .set({ telegramChatId: chatId })
      .where(eq(briefingSettingsTable.id, 1));
  }

  await sendHebrew(chatId, welcomeText());
}

let lastManualRefreshAt = 0;

async function handleOwnerCommand(
  chatId: string,
  command: string,
  argument?: string,
): Promise<void> {
  if (command === "/start") {
    await handleStart(chatId);
    return;
  }

  const settings = await ensureBriefingSettings();
  if (settings.telegramChatId !== chatId) {
    await sendHebrew(chatId, "הבוט הפרטי הזה כבר מחובר לבעלים שלו.");
    return;
  }

  if (command === "/pause") {
    await db
      .update(briefingSettingsTable)
      .set({ enabled: false })
      .where(eq(briefingSettingsTable.id, 1));
    await sendHebrew(chatId, "העדכונים האוטומטיים הושהו. אפשר להפעיל אותם שוב עם /resume.");
    return;
  }

  if (command === "/resume") {
    await db
      .update(briefingSettingsTable)
      .set({ enabled: true })
      .where(eq(briefingSettingsTable.id, 1));
    await sendHebrew(chatId, "העדכונים האוטומטיים הופעלו מחדש.");
    return;
  }

  if (command === "/help" || command === "/schedule" || command === "/interval") {
    await sendHebrew(chatId, welcomeText());
    return;
  }

  if (command === "/status") {
    const state = settings.enabled ? "פעילים" : "מושהים";
    const problem = settings.lastError
      ? "\nהבדיקה האחרונה נתקלה בבעיה. נסה /refresh או בדוק את לוגי השירות."
      : "";
    await sendHebrew(
      chatId,
      `מצב העדכונים: ${state}\nתדרוכים: ${scheduleHebrew()}\nידיעות חריגות נבדקות בזמן התדרוכים המתוזמנים\nרף חשיבות: ${settings.minImportance}/5\nבדיקה אחרונה: ${formatTime(settings.lastCheckedAt)}${settings.lastSentAt ? `\nתדרוך אחרון: ${formatTime(settings.lastSentAt)}` : ""}${problem}`,
    );
    return;
  }

  if (command === "/importance") {
    const importance = Number(argument);
    if (![3, 4, 5].includes(importance)) {
      await sendHebrew(
        chatId,
        "בחר רף חשיבות 3, 4 או 5. לדוגמה: /importance 4.",
      );
      return;
    }
    await db
      .update(briefingSettingsTable)
      .set({ minImportance: importance })
      .where(eq(briefingSettingsTable.id, 1));
    await sendHebrew(chatId, `נשמר. יישלחו סיפורים בדירוג ${importance}/5 ומעלה.`);
    return;
  }

  if (command === "/test") {
    await sendHebrew(
      chatId,
      "בדיקת החיבור הצליחה. תדרוכי החדשות יגיעו לכאן בעברית, עם קישור למקור והסבר על ההשפעה האפשרית על השוק.",
    );
    return;
  }

  if (command === "/refresh") {
    const now = Date.now();
    if (now - lastManualRefreshAt < 5 * 60 * 1000) {
      await sendHebrew(chatId, "אפשר להפעיל בדיקה ידנית פעם בחמש דקות. העדכון האוטומטי ימשיך כרגיל.");
      return;
    }
    lastManualRefreshAt = now;
    await sendHebrew(chatId, "מתחיל בדיקת חדשות ידנית. אשלח את הסיכום כשתסתיים.");
    try {
      const { refreshAndDeliver } = await import("./scheduler");
      const result = await refreshAndDeliver();
      await sendHebrew(
        chatId,
        `הבדיקה הושלמה. נותחו ${result.analyzed} סיפורים ונשמרו ${result.newStories} סיפורים חדשים.`,
      );
    } catch (error) {
      const reason = redactBotToken(error instanceof Error ? error.message : "Unknown refresh error");
      logger.warn({ reason }, "Manual Telegram news refresh failed");
      await sendHebrew(chatId, "הבדיקה נכשלה. בדוק שהחיבור ל־OpenAI פעיל ונסה שוב מאוחר יותר.");
    }
    return;
  }

  await sendHebrew(chatId, "הפקודה לא זוהתה. שלח /help לרשימת הפקודות.");
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text || message.chat.type !== "private") return;

  const [rawCommand = "", argument] = message.text.trim().split(/\s+/, 2);
  const command = rawCommand.split("@", 1)[0] ?? "";
  if (!command.startsWith("/")) return;
  await handleOwnerCommand(
    String(message.chat.id),
    command.toLowerCase(),
    argument,
  );
}

let pollingStarted = false;
let nextUpdateOffset = 0;

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const params = new URLSearchParams({
        offset: String(nextUpdateOffset),
        timeout: "25",
        allowed_updates: JSON.stringify(["message"]),
      });
      const updates = await telegramCall<TelegramUpdate[]>(`getUpdates?${params.toString()}`);
      for (const update of updates) {
        nextUpdateOffset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      const reason = redactBotToken(error instanceof Error ? error.message : "Unknown polling error");
      logger.warn({ reason }, "Telegram update polling failed");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

/**
 * Read one bounded Telegram update batch for an ephemeral scheduled runner.
 * Persist each offset only after handling its update so a failed run can retry it.
 */
export async function pollTelegramUpdatesOnce(): Promise<number> {
  const settings = await ensureBriefingSettings();
  const offset = settings.lastTelegramUpdateId + 1;
  const params = new URLSearchParams({
    offset: String(offset),
    timeout: "0",
    allowed_updates: JSON.stringify(["message"]),
  });
  const updates = await telegramCall<TelegramUpdate[]>(`getUpdates?${params.toString()}`);
  for (const update of updates) {
    await handleUpdate(update);
    await db
      .update(briefingSettingsTable)
      .set({ lastTelegramUpdateId: update.update_id })
      .where(eq(briefingSettingsTable.id, 1));
  }
  return updates.length;
}

export function startTelegramPolling(): void {
  if (pollingStarted || !botToken()) return;
  pollingStarted = true;
  void getTelegramBotUsername().catch((error: unknown) => {
    const reason = redactBotToken(error instanceof Error ? error.message : "Unknown Telegram error");
    logger.warn({ reason }, "Telegram bot information could not be loaded");
  });
  void pollLoop();
}
