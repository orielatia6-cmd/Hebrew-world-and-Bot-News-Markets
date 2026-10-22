import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const briefingSettingsTable = pgTable("briefing_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  deliveryIntervalMinutes: integer("delivery_interval_minutes").notNull().default(60),
  minImportance: integer("min_importance").notNull().default(4),
  telegramChatId: text("telegram_chat_id"),
  botUsername: text("bot_username"),
  lastTelegramUpdateId: integer("last_telegram_update_id").notNull().default(0),
  loginCodeHash: text("login_code_hash"),
  loginCodeExpiresAt: timestamp("login_code_expires_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastProcessedDigestSlotAt: timestamp("last_processed_digest_slot_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const briefingFeedHealthTable = pgTable("briefing_feed_health", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().$type<"world" | "trump" | "markets">(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessfulFetch: timestamp("last_successful_fetch", { withTimezone: true }),
  lastError: text("last_error"),
  recentStoryCount: integer("recent_story_count").notNull().default(0),
});

export const briefingStoriesTable = pgTable(
  "briefing_stories",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    sourceId: text("source_id").notNull(),
    revisionKey: text("revision_key").notNull(),
    eventKey: text("event_key").notNull(),
    originalTitle: text("original_title").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    sourceName: text("source_name").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    summary: text("summary").notNull(),
    whyItMatters: text("why_it_matters").notNull(),
    marketImpact: text("market_impact").notNull(),
    category: text("category").notNull().$type<"world" | "trump" | "markets">(),
    importance: integer("importance").notNull(),
    sentiment: text("sentiment").notNull().$type<"positive" | "negative" | "mixed" | "neutral">(),
    tickers: text("tickers").array().notNull().default(sql`'{}'::text[]`),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("briefing_stories_source_revision_unique").on(table.sourceId, table.revisionKey),
    uniqueIndex("briefing_stories_event_revision_unique").on(table.eventKey, table.revisionKey),
    index("briefing_stories_created_at_idx").on(table.createdAt),
    index("briefing_stories_category_created_at_idx").on(table.category, table.createdAt),
  ],
);

export const insertBriefingSettingsSchema = createInsertSchema(briefingSettingsTable).omit({
  id: true,
  updatedAt: true,
});
export const insertBriefingStorySchema = createInsertSchema(briefingStoriesTable);

export type BriefingSettings = typeof briefingSettingsTable.$inferSelect;
export type InsertBriefingSettings = z.infer<typeof insertBriefingSettingsSchema>;
export type BriefingStory = typeof briefingStoriesTable.$inferSelect;
export type InsertBriefingStory = z.infer<typeof insertBriefingStorySchema>;
