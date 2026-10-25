import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const diagnostics = await load("lib/briefing/diagnostics.ts", {});

test("read-only schema inspection checks only required metadata", async () => {
  const calls = [];
  const allColumns = Object.entries(diagnostics.requiredBriefingColumns).flatMap(
    ([table_name, names]) => names.map((column_name) => ({ table_name, column_name })),
  );

  const result = await diagnostics.inspectBriefingSchema(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("information_schema.columns")) return { rows: allColumns };
    if (sql.includes("FROM pg_indexes")) {
      return {
        rows: diagnostics.requiredBriefingIndexes.map((indexname) => ({
          indexname,
          indexdef: `CREATE UNIQUE INDEX ${indexname} ON briefing_stories (...)`,
        })),
      };
    }
    throw new Error("Unexpected query");
  });

  assert.deepEqual(result, { missingColumns: [], missingIndexes: [] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /information_schema\.columns/);
  assert.match(calls[1].sql, /FROM pg_indexes/);
  assert.deepEqual(calls[0].values, [Object.keys(diagnostics.requiredBriefingColumns)]);
});

test("schema inspection identifies missing columns and indexes without reading rows", async () => {
  const result = await diagnostics.inspectBriefingSchema(async (sql) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ table_name: "briefing_settings", column_name: "id" }] };
    }
    return { rows: [] };
  });

  assert.ok(result.missingColumns.includes("briefing_stories.revision_key"));
  assert.ok(result.missingColumns.includes("briefing_settings.last_processed_digest_slot_at"));
  assert.deepEqual(result.missingIndexes, [...diagnostics.requiredBriefingIndexes]);
});

test("safe error summary reports allowlisted schema details but never raw messages", () => {
  const error = Object.assign(
    new Error(
      'column "revision_key" of relation "briefing_stories" does not exist; token=do-not-log',
    ),
    { code: "42703" },
  );
  const output = diagnostics.safeErrorSummary(error);

  assert.equal(output, "type=Error code=42703 missing=briefing_stories.revision_key");
  assert.doesNotMatch(output, /do-not-log|token=/);
});

test("safe error summary filters unsafe error names, codes, statuses, and messages", () => {
  const error = Object.assign(
    new Error("postgres://user:password@host/private and Telegram token value"),
    {
      name: "Bearer token value",
      code: "postgres://user:password@host",
      status: 999,
    },
  );
  const output = diagnostics.safeErrorSummary(error);

  assert.equal(output, "type=Error");
  assert.doesNotMatch(output, /password|Telegram|Bearer|host|postgres:\/\//);
});

test("migration preflight is read-only and permits only a duplicate-free full upgrade", async () => {
  const calls = [];
  const result = await diagnostics.inspectMigrationPreflight(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("information_schema.tables")) {
      return {
        rows: [
          { table_name: "briefing_settings" },
          { table_name: "briefing_stories" },
        ],
      };
    }
    if (sql.includes("information_schema.columns")) return { rows: [] };
    if (sql.includes("FROM pg_indexes")) {
      return {
        rows: [{
          tablename: "briefing_stories",
          indexname: diagnostics.legacySourceIndex,
          indexdef: "CREATE UNIQUE INDEX briefing_stories_source_id_unique ON briefing_stories (source_id)",
        }],
      };
    }
    if (sql.includes("FROM pg_constraint")) {
      return { rows: [{ index_owned_by_constraint: false }] };
    }
    if (sql.includes("COUNT(*)")) {
      return {
        rows: [{
          stories_to_backfill: "12",
          invalid_legacy_values: "0",
          has_duplicate_source_ids: false,
        }],
      };
    }
    throw new Error("Unexpected query");
  });

  assert.equal(result.decision, "ready");
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.presentTargetColumns, []);
  assert.equal(result.legacySourceUniqueIndexPresent, true);
  assert.equal(result.legacySourceIndexOwnedByConstraint, false);
  assert.equal(result.hasDuplicateSourceIds, false);
  assert.equal(result.invalidLegacyValues, 0);
  assert.equal(result.storiesToBackfill, 12);
  assert.ok(calls.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
});

test("migration preflight blocks source-id duplicates and partial schema states", async () => {
  const duplicateResult = await diagnostics.inspectMigrationPreflight(async (sql) => {
    if (sql.includes("information_schema.tables")) {
      return { rows: [{ table_name: "briefing_settings" }, { table_name: "briefing_stories" }] };
    }
    if (sql.includes("information_schema.columns")) return { rows: [] };
    if (sql.includes("FROM pg_indexes")) return { rows: [] };
    if (sql.includes("FROM pg_constraint")) {
      return { rows: [{ index_owned_by_constraint: false }] };
    }
    return {
      rows: [{
        stories_to_backfill: "3",
        invalid_legacy_values: "0",
        has_duplicate_source_ids: true,
      }],
    };
  });
  assert.equal(duplicateResult.decision, "blocked");
  assert.equal(duplicateResult.hasDuplicateSourceIds, true);

  const partialResult = await diagnostics.inspectMigrationPreflight(async (sql) => {
    if (sql.includes("information_schema.tables")) {
      return { rows: [{ table_name: "briefing_settings" }, { table_name: "briefing_stories" }] };
    }
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ table_name: "briefing_stories", column_name: "revision_key" }] };
    }
    if (sql.includes("FROM pg_indexes")) return { rows: [] };
    if (sql.includes("FROM pg_constraint")) {
      return { rows: [{ index_owned_by_constraint: false }] };
    }
    return {
      rows: [{
        stories_to_backfill: "3",
        invalid_legacy_values: "0",
        has_duplicate_source_ids: false,
      }],
    };
  });
  assert.equal(partialResult.decision, "blocked");
  assert.deepEqual(partialResult.presentTargetColumns, ["briefing_stories.revision_key"]);
});

test("read-only delivery audit reports delivery, pause, source, and pending-story aggregates", async () => {
  const calls = [];
  const result = await diagnostics.inspectDeliveryActivity(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM briefing_stories")) {
      return {
        rows: [{
          delivered_in_window: "2",
          latest_delivery_at: new Date("2026-10-25T09:00:00.000Z"),
          recent_undelivered_stories: "4",
          recent_eligible_undelivered_stories: "1",
        }],
      };
    }
    if (sql.includes("FROM briefing_settings")) {
      return {
        rows: [{
          enabled: true,
          telegram_chat_configured: true,
          last_scheduler_error_present: false,
          min_importance: 4,
          last_checked_at: new Date("2026-10-25T09:01:00.000Z"),
          last_sent_at: new Date("2026-10-25T08:59:00.000Z"),
          last_processed_digest_slot_at: new Date("2026-10-25T09:00:00.000Z"),
        }],
      };
    }
    if (sql.includes("FROM briefing_feed_health")) {
      return {
        rows: [{
          configured_feeds: "11",
          feeds_succeeded_in_window: "10",
          feeds_failed_in_window: "1",
          latest_feed_success_at: new Date("2026-10-25T09:02:00.000Z"),
        }],
      };
    }
    throw new Error("Unexpected query");
  });

  assert.deepEqual(result, {
    windowMinutes: 30,
    storiesDeliveredInWindow: 2,
    latestStoryDeliveryAt: "2026-10-25T09:00:00.000Z",
    lastDigestSentAt: "2026-10-25T08:59:00.000Z",
    lastProcessedDigestSlotAt: "2026-10-25T09:00:00.000Z",
    lastCheckedAt: "2026-10-25T09:01:00.000Z",
    briefingEnabled: true,
    telegramChatConfigured: true,
    lastSchedulerErrorPresent: false,
    minImportance: 4,
    configuredFeeds: 11,
    feedsSucceededInWindow: 10,
    feedsFailedInWindow: 1,
    latestFeedSuccessAt: "2026-10-25T09:02:00.000Z",
    recentUndeliveredStories: 4,
    recentEligibleUndeliveredStories: 1,
  });
  assert.ok(calls.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
  assert.deepEqual(calls.map(({ values }) => values), [[30], [], [30]]);
  await assert.rejects(
    diagnostics.inspectDeliveryActivity(async () => ({ rows: [] }), 0),
    RangeError,
  );
});
