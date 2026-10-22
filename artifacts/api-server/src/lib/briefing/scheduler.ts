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

function storyParagraphs(story: typeof briefingStoriesTable.$inferSelect): string[] {
  const tickers =
    story.tickers.length > 0 ? `\nסימולים: ${story.tickers.join(", ")}` : "";
  return [
    `${categoryLabel(story.category)} · חשיבות ${story.importance}/5`,
    story.title,
    `מה קרה (לפי המקור): ${story.summary}`,
    `למה זה חשוב: ${story.whyItMatters}`,
    `השפעה אפשרית על השוק (ניתוח): ${story.marketImpact}${tickers}`,
    `מקור: ${story.sourceName}\n${story.url}`,
  ];
}

function splitOversizedParagraph(paragraph: string, maxLength: number): string[] {
  if (paragraph.length <= maxLength) return [paragraph];

  const sentences = paragraph.split(/(?<=[.!?…])\s+/u);
  const chunks: string[] = [];
  let current = "";
  const addPiece = (piece: string) => {
    if (piece.length <= maxLength) {
      if (current && current.length + 1 + piece.length > maxLength) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current} ${piece}` : piece;
      return;
    }

    const words = piece.match(/\S+\s*/gu) ?? [piece];
    for (const word of words) {
      if (word.length > maxLength) {
        if (current) chunks.push(current);
        current = "";
        const characters = Array.from(word);
        while (characters.length > maxLength) {
          chunks.push(characters.splice(0, maxLength).join(""));
        }
        current = characters.join("");
      } else if (current.length + word.length > maxLength) {
        chunks.push(current);
        current = word;
      } else {
        current += word;
      }
    }
  };

  for (const sentence of sentences) addPiece(sentence);
  if (current) chunks.push(current);
  return chunks;
}

type TelegramChunk = { text: string; storyIds: number[] };

function splitStoriesIntoMessages(
  stories: (typeof briefingStoriesTable.$inferSelect)[],
  breaking: boolean,
): TelegramChunk[] {
  const header = [
    breaking ? "התראת חדשות משמעותית" : "תדרוך חדשות חשוב",
    "העובדות מיוחסות למקור; השפעת השוק היא ניתוח אפשרי בלבד, לא תחזית או ייעוץ השקעות.",
    "",
  ].join("\n");
  const footer = `תדרוכים: ${scheduleHebrew()}\nלהשהיה: /pause`;
  const contentBudget = TELEGRAM_SAFE_LENGTH - header.length - footer.length - 12;
  const messages: TelegramChunk[] = [];
  let paragraphs: string[] = [];
  let storyIds = new Set<number>();
  let contentLength = 0;

  const flush = () => {
    if (paragraphs.length === 0) return;
    const text = `${header}${paragraphs.join("\n\n")}\n\n${footer}`;
    if (text.length > TELEGRAM_SAFE_LENGTH) {
      throw new Error("A Telegram briefing chunk exceeded its safe message limit.");
    }
    messages.push({ text, storyIds: [...storyIds] });
    paragraphs = [];
    storyIds = new Set<number>();
    contentLength = 0;
  };

  for (const story of stories) {
    for (const paragraph of storyParagraphs(story)) {
      for (const piece of splitOversizedParagraph(paragraph, contentBudget)) {
        const addition = piece.length + (paragraphs.length ? 2 : 0);
        if (contentLength + addition > contentBudget) flush();
        paragraphs.push(piece);
        contentLength += piece.length + (paragraphs.length > 1 ? 2 : 0);
        storyIds.add(story.id);
      }
    }
  }
  flush();
  return messages;
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
        right.publishedAt.getTime() - left.publishedAt.getTime(),
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

  const messages = splitStoriesIntoMessages(pending, breaking);
  const finalMessageByStory = new Map<number, number>();
  messages.forEach((message, index) => {
    message.storyIds.forEach((storyId) => finalMessageByStory.set(storyId, index));
  });

  for (const [index, message] of messages.entries()) {
    await sendTelegramMessage(settings.telegramChatId, message.text);
    const completedStoryIds = message.storyIds.filter(
      (storyId) => finalMessageByStory.get(storyId) === index,
    );
    const deliveredAt = new Date();
    if (completedStoryIds.length > 0) {
      await db
        .update(briefingStoriesTable)
        .set({ deliveredAt })
        .where(
          and(
            inStoryIds(completedStoryIds),
            isNull(briefingStoriesTable.deliveredAt),
          ),
        );
    }
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
