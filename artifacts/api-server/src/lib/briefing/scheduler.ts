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
import { digestSlot, scheduleHebrew } from "./schedule";

const SOURCE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_STORIES_PER_DIGEST = 3;
let schedulerStarted = false;
let tickInProgress = false;

function clipped(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function categoryLabel(category: string): string {
  if (category === "trump") return "טראמפ";
  if (category === "markets") return "שווקים וטכנולוגיה";
  return "עולם";
}

function storyBlock(story: typeof briefingStoriesTable.$inferSelect): string {
  const tickers =
    story.tickers.length > 0 ? `\nסימולים: ${story.tickers.join(", ")}` : "";
  return [
    `${categoryLabel(story.category)} · חשיבות ${story.importance}/5`,
    clipped(story.title, 160),
    `מה קרה: ${clipped(story.summary, 280)}`,
    `למה זה חשוב: ${clipped(story.whyItMatters, 220)}`,
    `השפעה אפשרית על השוק: ${clipped(story.marketImpact, 260)}${tickers}`,
    `מקור: ${story.url}`,
  ].join("\n");
}

function splitStoriesIntoMessages(
  stories: (typeof briefingStoriesTable.$inferSelect)[],
): Array<(typeof briefingStoriesTable.$inferSelect)[]> {
  const groups: Array<(typeof briefingStoriesTable.$inferSelect)[]> = [];
  let current: (typeof briefingStoriesTable.$inferSelect)[] = [];
  let currentLength = 180;

  for (const story of stories) {
    const blockLength = storyBlock(story).length + 2;
    if (current.length > 0 && currentLength + blockLength > 3_600) {
      groups.push(current);
      current = [];
      currentLength = 180;
    }
    current.push(story);
    currentLength += blockLength;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

async function dispatchPendingStories(force = false, breaking = false): Promise<number> {
  const settings = await ensureBriefingSettings();
  if (!settings.enabled || !settings.telegramChatId) return 0;

  const slot = digestSlot(new Date(), settings.lastSentAt);
  if (!force && !breaking && !slot) return 0;

  const pending = await db
    .select()
    .from(briefingStoriesTable)
    .where(
      and(
        isNull(briefingStoriesTable.deliveredAt),
        gte(briefingStoriesTable.importance, breaking ? 5 : settings.minImportance),
        gte(briefingStoriesTable.publishedAt, new Date(Date.now() - (breaking ? 2 : 24) * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(briefingStoriesTable.importance), desc(briefingStoriesTable.createdAt))
    .limit(MAX_STORIES_PER_DIGEST);

  if (pending.length === 0) {
    if (!breaking && !force) {
      await sendTelegramMessage(settings.telegramChatId, "תדרוך חדשות מתוזמן\nאין כרגע ידיעות חדשות שעומדות ברף החשיבות. ידיעות שכבר נשלחו לא יישלחו שוב.");
      await db.update(briefingSettingsTable).set({ lastSentAt: new Date() }).where(eq(briefingSettingsTable.id, 1));
    }
    return 0;
  }

  const messages = splitStoriesIntoMessages(pending);
  for (const group of messages) {
    const body = [
      breaking ? "התראת חדשות משמעותית" : "תדרוך חדשות חשוב",
      "הסברים לשוק הם אפשריים בלבד ואינם תחזית או ייעוץ השקעות.",
      "",
      ...group.map(storyBlock),
      "",
      `תדרוכים: ${scheduleHebrew()}\nלהשהיה: /pause`,
    ].join("\n\n");

    if (body.length > 3_900) {
      throw new Error("The Telegram briefing exceeded the message size limit.");
    }

    await sendTelegramMessage(settings.telegramChatId, body);
    const deliveredAt = new Date();
    await db
      .update(briefingStoriesTable)
      .set({ deliveredAt })
      .where(
        and(
          inStoryIds(group.map((story) => story.id)),
          isNull(briefingStoriesTable.deliveredAt),
        ),
      );
    await db
      .update(briefingSettingsTable)
      .set({ ...(!breaking && !force ? { lastSentAt: deliveredAt } : {}), lastError: null })
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
