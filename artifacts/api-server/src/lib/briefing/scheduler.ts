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

function sourceTrustRank(sourceName: string): number {
  return /\breuters\b|\bassociated press\b|\bbbc\b|\bbloomberg\b|\bfinancial times\b|\bwall street journal\b|\bfederal reserve\b|\bsec\b/i.test(
    sourceName,
  )
    ? 2
    : /\bcnbc\b|\bnew york times\b|\bguardian\b|\byahoo finance\b/i.test(sourceName)
      ? 1
      : 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sourceLinkLabel(sourceName: string, sourceUrl: URL): string {
  if (sourceUrl.hostname !== "news.google.com") return sourceName;
  if (/google news/i.test(sourceName)) return "Google News";
  return `${sourceName} · דרך Google News`;
}

function compactHeadline(title: string): string {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  return words.length <= 12 ? words.join(" ") : `${words.slice(0, 11).join(" ")}…`;
}

function categoryEmoji(category: string): string {
  if (category === "world") return "🌍";
  if (category === "trump") return "🇺🇸";
  if (category === "markets") return "📊";
  return "🗞️";
}

function comparisonText(text: string): string {
  return text
    .toLocaleLowerCase("he")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function removeHeadlineEcho(title: string, summary: string): string {
  const titleKey = comparisonText(title);
  if (!titleKey) return summary.trim();
  const sentences = summary.match(/[^.!?…]+[.!?…]?/gu) ?? [summary];
  return sentences
    .filter((sentence) => comparisonText(sentence) !== titleKey)
    .join(" ")
    .trim();
}

function ensureSentenceEnd(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function conciseSentences(text: string, maximum: number): string {
  const trimmed = text.trim();
  // Older stored analyses may be abnormally long. Keep all their content and
  // let the safe Telegram splitter divide it instead of silently truncating.
  if (trimmed.length > 1_200) return trimmed;
  const sentences = trimmed.split(/(?<=[.!?…])\s+/u).filter(Boolean);
  return sentences.slice(0, maximum).join(" ").trim();
}

function hasMarketRelevance(
  story: typeof briefingStoriesTable.$inferSelect,
  summary: string,
  whyItMatters: string,
  marketImpact: string,
): boolean {
  if (story.category === "markets" || story.tickers.length > 0) return true;
  const evidence = `${story.title} ${summary} ${whyItMatters} ${marketImpact}`;
  return /שוק|שווקים|מניות|מדד|בורסה|תשואות|אג["״']?ח|ריבית|פד|פדרל ריזרב|אינפלציה|מכסים|דולר|נפט|נאסד["״]?ק|נאסדק|s&p|nasdaq|fed|tariff|nvidia|tesla|semiconductor|שבבים|בינה מלאכותית|ai\b/i.test(
    evidence,
  );
}

function hasSpecificMarketImpact(text: string, tickers: string[]): boolean {
  const normalized = comparisonText(text);
  if (normalized.length < 12) return false;
  if (
    /^(?:אין קשר(?: ישיר)? לשוק|אין השפעה(?: ישירה)? על השוק|לא צפויה השפעה(?: ישירה)?|אין די מידע להעריך|לא ניתן להעריך את ההשפעה|ההשפעה אינה ברורה)|באופן כללי|ללא פרטים נוספים|תלויה בפרטים נוספים$/.test(
      normalized,
    )
  ) {
    return false;
  }
  return tickers.length > 0 || /מניות|מדדי|מדד|s&p|nasdaq|נאסד|אג["״']?ח|תשואות|ריבית|ציפיות הריבית|דולר|נפט|מחירי|שבבים|מגזר|סקטור|טכנולוגיה|אשראי|מימון|equities|stocks|yields|rates|bonds|semiconductor|sector|index/i.test(text);
}

function formatStoryMessage(
  story: typeof briefingStoriesTable.$inferSelect,
  breaking = false,
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

  const summaryText = conciseSentences(
    removeHeadlineEcho(story.title, story.summary),
    2,
  );
  const summary = summaryText ? ensureSentenceEnd(summaryText) : "";
  const whyItMatters = ensureSentenceEnd(conciseSentences(story.whyItMatters, 1));
  const marketImpactText = conciseSentences(story.marketImpact, 1);
  const showMarketImpact =
    hasMarketRelevance(story, summary, whyItMatters, marketImpactText) &&
    hasSpecificMarketImpact(marketImpactText, story.tickers);
  const marketImpact = showMarketImpact
    ? ensureSentenceEnd(marketImpactText)
    : "";
  const analysisText = `${whyItMatters} ${marketImpact}`.toUpperCase();
  const additionalTickers = story.tickers.filter(
    (ticker) => !analysisText.includes(ticker.toUpperCase()),
  );
  const tickerText = additionalTickers.length > 0
    ? ` (${escapeHtml(additionalTickers.join(", "))})`
    : "";

  return [
    breaking ? "🚨 <b>עדכון דחוף</b>" : "",
    `<b>${categoryEmoji(story.category)} ${escapeHtml(compactHeadline(story.title))}</b>`,
    summary ? `📰 <b>מה קרה:</b>\n${escapeHtml(summary)}` : "",
    `🧠 <b>למה זה חשוב:</b>\n${escapeHtml(whyItMatters)}`,
    showMarketImpact
      ? `📈 <b>השפעה אפשרית:</b>\n${escapeHtml(marketImpact)}${tickerText}`
      : "",
    `🔗 <a href="${escapeHtml(sourceUrl.toString())}">מקור: ${escapeHtml(sourceLinkLabel(story.sourceName, sourceUrl))}</a>`,
  ].filter(Boolean).join("\n\n");
}

type HtmlTag = { name: string; opening: string };

function splitHtmlMessage(message: string, maxLength: number): string[] {
  const rawTokens = message.match(/<[^>]+>|&(?:amp|lt|gt|quot|#39);|[\s\S]/gu) ?? [];
  const tokens: string[] = [];
  let textBuffer = "";
  const flushTextBuffer = () => {
    if (textBuffer) tokens.push(textBuffer);
    textBuffer = "";
  };
  for (const token of rawTokens) {
    if (token.startsWith("<") || token.startsWith("&")) {
      flushTextBuffer();
      tokens.push(token);
    } else {
      textBuffer += token;
    }
  }
  flushTextBuffer();

  const chunks: string[] = [];
  const openTags: HtmlTag[] = [];
  let current = "";
  let currentHasContent = false;
  const openingMarkup = () => openTags.map((tag) => tag.opening).join("");
  const closingMarkup = () => [...openTags].reverse().map((tag) => `</${tag.name}>`).join("");

  const flush = () => {
    if (currentHasContent) {
      const complete = `${current}${closingMarkup()}`;
      if (complete.length > maxLength) {
        throw new Error("A Telegram HTML message exceeded its safe length while closing tags.");
      }
      chunks.push(complete);
    }
    current = openingMarkup();
    currentHasContent = false;
  };

  const appendText = (text: string) => {
    let remaining = text;
    while (remaining) {
      const available = maxLength - current.length - closingMarkup().length;
      const characters = Array.from(remaining);
      let fitCount = 0;
      let fitLength = 0;
      while (fitCount < characters.length && fitLength + characters[fitCount]!.length <= available) {
        fitLength += characters[fitCount]!.length;
        fitCount++;
      }
      if (fitCount === characters.length) {
        current += remaining;
        currentHasContent = true;
        return;
      }
      if (fitCount === 0) {
        if (!currentHasContent) {
          throw new Error("Telegram HTML tags leave no room for message content.");
        }
        flush();
        continue;
      }

      let cutCount = fitCount;
      for (let index = fitCount - 1; index >= 0; index--) {
        if (/\s/u.test(characters[index]!)) {
          cutCount = index + 1;
          break;
        }
      }
      const part = characters.slice(0, cutCount).join("");
      current += part;
      currentHasContent = true;
      remaining = characters.slice(cutCount).join("");
      flush();
    }
  };

  for (const token of tokens) {
    const tag = token.match(/^<(\/?)(b|a)(?:\s+href="[^"]*")?>$/i);
    if (tag) {
      const isClosing = tag[1] === "/";
      const name = tag[2]!.toLowerCase();
      if (isClosing) {
        const top = openTags.at(-1);
        if (!top || top.name !== name) {
          throw new Error("Telegram message contains unbalanced HTML tags.");
        }
        openTags.pop();
        if (current.length + token.length + closingMarkup().length > maxLength) {
          openTags.push(top);
          if (!currentHasContent) {
            throw new Error("Telegram HTML closing tag exceeds the safe message length.");
          }
          flush();
          openTags.pop();
        }
        current += token;
      } else {
        const nextTag = { name, opening: token };
        const nextClosingLength = closingMarkup().length + `</${name}>`.length;
        if (current.length + token.length + nextClosingLength > maxLength) {
          if (!currentHasContent) {
            throw new Error("Telegram HTML opening tag exceeds the safe message length.");
          }
          flush();
        }
        if (current.length + token.length + nextClosingLength > maxLength) {
          throw new Error("Telegram HTML opening tag exceeds the safe message length.");
        }
        current += token;
        openTags.push(nextTag);
      }
      continue;
    }

    if (token.startsWith("<")) {
      throw new Error("Telegram message contains unsupported HTML markup.");
    }
    if (token.startsWith("&")) {
      const available = maxLength - current.length - closingMarkup().length;
      if (token.length > available) {
        if (!currentHasContent) {
          throw new Error("A Telegram HTML entity exceeds the safe message length.");
        }
        flush();
      }
      if (token.length > maxLength - current.length - closingMarkup().length) {
        throw new Error("A Telegram HTML entity exceeds the safe message length.");
      }
      current += token;
      currentHasContent = true;
      continue;
    }
    appendText(token);
  }

  if (openTags.length > 0) {
    throw new Error("Telegram message contains unclosed HTML tags.");
  }
  if (currentHasContent) {
    if (current.length > maxLength) {
      throw new Error("A Telegram HTML message exceeded its safe length.");
    }
    chunks.push(current);
  }
  return chunks;
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

  const messages = pending.flatMap((story) => {
    const parts = splitHtmlMessage(
      formatStoryMessage(story, breaking),
      TELEGRAM_SAFE_LENGTH,
    );
    return parts.map((text, index) => ({
      text,
      storyId: story.id,
      finalPart: index === parts.length - 1,
    }));
  });

  for (const message of messages) {
    await sendTelegramMessage(settings.telegramChatId, message.text, "HTML");
    if (!message.finalPart) continue;
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
