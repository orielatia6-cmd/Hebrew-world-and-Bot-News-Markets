import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  db,
  briefingSettingsTable,
  briefingStoriesTable,
} from "@workspace/db";
import { logger } from "../logger";
import { redactBotToken } from "./secret-safety";
import { refreshNews } from "./news";
import { ensureBriefingSettings } from "./store";
import { sendTelegramMessage } from "./telegram";
import { digestSlot } from "./schedule";

const SOURCE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_STORIES_PER_DIGEST = 3;
const TELEGRAM_SAFE_LENGTH = 3_800;
let schedulerStarted = false;
let tickInProgress = false;

function categoryLabel(category: string): string {
  if (category === "trump") return "טראמפ";
  if (category === "markets") return "שווקים וטכנולוגיה";
  return "עולם";
}

function sourceTrustRank(sourceName: string): number {
  return /\breuters\b|\bassociated press\b|\bbbc\b|\bbloomberg\b|\bfinancial times\b|\bwall street journal\b|\bfederal reserve\b|\bsec\b/i.test(
    sourceName,
  )
    ? 2
    : /\bcnbc\b|\bnew york times\b|\bguardian\b/i.test(sourceName)
      ? 1
      : 0;
}

function formatPublishedAt(value: Date | null): string {
  if (!value) return "מועד הפרסום לא זמין";
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isMarketRelated(story: typeof briefingStoriesTable.$inferSelect): boolean {
  if (story.category === "markets" || story.tickers.length > 0) return true;
  if (/(?:אין|ללא)\s+(?:קשר|השפעה)\s+(?:ישיר(?:ה)?\s+)?לשוק|לא צפויה השפעה ישירה על השוק/u.test(story.marketImpact)) {
    return false;
  }
  return /שוק|מניות|מדד|מדדים|סקטור|ענף|תשואות|אג"ח|ריבית|נפט|דולר|מטבע|בורסה|nasdaq|s&p|dow|nvidia|tesla|semiconductor|שבבים/u.test(
    story.marketImpact,
  );
}

function recommendationForStory(story: typeof briefingStoriesTable.$inferSelect): string {
  if (!isMarketRelated(story)) {
    return `לעקוב אחר עדכונים מאומתים בנושא אצל ${story.sourceName}, ולבדוק אם פרטים חדשים משנים את התמונה.`;
  }

  const assets = story.tickers.length > 0
    ? `לעקוב אחר תגובת ${story.tickers.join(", ")}`
    : "לעקוב אחר תגובת הנכסים והמדדים שמוזכרים בניתוח";
  const bullish = story.sentiment === "negative"
    ? "יתפרסמו עדכונים מאומתים שיצמצמו את הסיכון המתואר."
    : "יתפרסמו עדכונים מאומתים שיחזקו את ההשפעה החיובית שתוארה.";
  const bearish = story.sentiment === "positive"
    ? "יתפרסמו עובדות חדשות שיחלישו את ההנחה החיובית."
    : "יתפרסמו עדכונים מאומתים שיחזקו את הסיכון או את ההשפעה השלילית שתוארה.";
  return `${assets} והודעת ההמשך בנושא. שורי: אם ${bullish} דובי: אם ${bearish} לא ודאי: אם המידע יישאר חלקי או שהתגובה תהיה מעורבת. זו מסגרת למעקב, לא הוראת קנייה או מכירה.`;
}

function formatStoryMessage(
  story: typeof briefingStoriesTable.$inferSelect,
): string {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(story.url);
  } catch {
    throw new Error(`Story ${story.id} has an invalid source URL.`);
  }
  if (!["http:", "https:"].includes(sourceUrl.protocol)) {
    throw new Error(`Story ${story.id} has an unsupported source URL protocol.`);
  }

  const tickers = story.tickers.length > 0
    ? `\nסימולים רלוונטיים: ${escapeHtml(story.tickers.join(", "))}`
    : "";
  const text = [
    `🔴 <b>${escapeHtml(categoryLabel(story.category))} · ${escapeHtml(story.title)}</b>`,
    "",
    `📰 <b>NEWS:</b>\n${escapeHtml(story.summary)}`,
    "",
    `🧠 <b>AI ANALYSIS:</b>\n${escapeHtml(story.whyItMatters)}`,
    "",
    `📈 <b>AI RECOMMENDATION:</b>\n${escapeHtml(recommendationForStory(story))}`,
    "",
    `🎯 <b>POTENTIAL MARKET IMPACT:</b>\n${escapeHtml(story.marketImpact)}${tickers}`,
    "",
    `🕒 ${formatPublishedAt(story.publishedAt)} · 🔗 <a href="${escapeHtml(sourceUrl.toString())}">${escapeHtml(story.sourceName)}</a>`,
  ].join("\n");

  if (text.length > TELEGRAM_SAFE_LENGTH) {
    throw new Error(`Story ${story.id} exceeds Telegram's single-message safe limit.`);
  }
  return text;
}

async function dispatchPendingStories(force = false, breaking = false): Promise<number> {
  const settings = await ensureBriefingSettings();
  if (!settings.enabled || !settings.telegramChatId) return 0;

  const slot = digestSlot(new Date(), settings.lastProcessedDigestSlotAt);
  if (!force && !breaking && !slot) return 0;

  const eligible = await db
    .select()
    .from(briefingStoriesTable)
    .where(
      and(
        isNull(briefingStoriesTable.deliveredAt),
        gte(briefingStoriesTable.importance, breaking ? 5 : settings.minImportance),
        gte(briefingStoriesTable.publishedAt, new Date(Date.now() - (breaking ? 2 : 24) * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(briefingStoriesTable.importance), desc(briefingStoriesTable.publishedAt))
    .limit(40);
  const pending = eligible
    .sort(
      (left, right) =>
        right.importance - left.importance ||
        sourceTrustRank(right.sourceName) - sourceTrustRank(left.sourceName) ||
        (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0),
    )
    .slice(0, MAX_STORIES_PER_DIGEST);

  if (pending.length === 0) {
    if (!breaking && !force) {
      await db
        .update(briefingSettingsTable)
        .set({ lastProcessedDigestSlotAt: slot, lastError: null })
        .where(eq(briefingSettingsTable.id, 1));
    }
    return 0;
  }

  const messages = pending.map((story) => ({
    text: formatStoryMessage(story),
    storyId: story.id,
  }));

  for (const message of messages) {
    await sendTelegramMessage(settings.telegramChatId, message.text, "HTML");
    const deliveredAt = new Date();
    await db
      .update(briefingStoriesTable)
      .set({ deliveredAt })
      .where(
        and(
          inStoryIds([message.storyId]),
          isNull(briefingStoriesTable.deliveredAt),
        ),
      );
    await db
      .update(briefingSettingsTable)
      .set({
        ...(!breaking && !force
          ? { lastSentAt: deliveredAt }
          : {}),
        lastError: null,
      })
      .where(eq(briefingSettingsTable.id, 1));
  }

  if (!breaking && !force && slot) {
    await db
      .update(briefingSettingsTable)
      .set({ lastProcessedDigestSlotAt: slot })
      .where(eq(briefingSettingsTable.id, 1));
  }
  return pending.length;
}

function inStoryIds(ids: number[]) {
  return inArray(briefingStoriesTable.id, ids);
}

async function recordSchedulerError(error: unknown, refreshAttempt = false): Promise<void> {
  const reason = redactBotToken(
    error instanceof Error ? error.message : "Unknown background error",
  ).slice(0, 400);
  logger.error({ reason }, "Briefline background task failed");
  try {
    await ensureBriefingSettings();
    await db
      .update(briefingSettingsTable)
      .set({
        lastError: reason,
        ...(refreshAttempt ? { lastCheckedAt: new Date() } : {}),
      })
      .where(eq(briefingSettingsTable.id, 1));
  } catch (databaseError) {
    logger.error(
      {
        reason: redactBotToken(
          databaseError instanceof Error
            ? databaseError.message
            : "Unknown database error",
        ).slice(0, 200),
      },
      "Could not save briefing task error",
    );
  }
}

async function schedulerTick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    const settings = await ensureBriefingSettings();
    if (!settings.telegramChatId || !settings.enabled) return;
    const shouldRefresh =
      !settings.lastCheckedAt ||
      Date.now() - settings.lastCheckedAt.getTime() >= SOURCE_CHECK_INTERVAL_MS;

    if (shouldRefresh) {
      try {
        await refreshNews();
      } catch (error) {
        await recordSchedulerError(error, true);
      }
    }

    try {
      await dispatchPendingStories(false, true);
      await dispatchPendingStories();
    } catch (error) {
      await recordSchedulerError(error);
    }
  } finally {
    tickInProgress = false;
  }
}

export async function refreshAndDeliver(): Promise<{
  fetched: number;
  analyzed: number;
  newStories: number;
}> {
  if (tickInProgress) {
    throw new Error("עדכון אוטומטי כבר פועל. נסה שוב בעוד רגע.");
  }
  tickInProgress = true;
  try {
    const result = await refreshNews();
    await dispatchPendingStories(true);
    return result;
  } catch (error) {
    await recordSchedulerError(error, true);
    throw error;
  } finally {
    tickInProgress = false;
  }
}

export function startBriefingScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  void ensureBriefingSettings()
    .then(() => schedulerTick())
    .catch((error: unknown) => {
      void recordSchedulerError(error);
    });

  const timer = setInterval(() => {
    void schedulerTick();
  }, 60_000);
  timer.unref();
}

/**
 * Run exactly one scheduler pass for an ephemeral job runner.
 * The caller owns locking and process shutdown; this function starts no timers.
 */
export async function runScheduledJob(): Promise<void> {
  await schedulerTick();
}
