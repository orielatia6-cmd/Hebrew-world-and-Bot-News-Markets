import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "@workspace/db";
import { runScheduledJob } from "./lib/briefing/scheduler";
import { digestSlot } from "./lib/briefing/schedule";
import { getTelegramBotUsername, pollTelegramUpdatesOnce } from "./lib/briefing/telegram";
import {
  inspectMigrationPreflight,
  inspectBriefingSchema,
  safeErrorSummary,
} from "./lib/briefing/diagnostics";

const ADVISORY_LOCK_ID = 7_842_190_631;
const schemaCheckMode = process.argv.includes("--schema-check");
const migrationPreflightMode = process.argv.includes("--migration-preflight");
const applyMigrationMode = process.argv.includes("--apply-news-quality-migration");

async function runReadOnlyMigrationPreflight(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 5000");
    const preflight = await inspectMigrationPreflight(async (sql, values) => {
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as Array<Record<string, unknown>> };
    });
    await client.query("COMMIT");
    console.log(formatMigrationPreflight(preflight));
    if (preflight.decision === "blocked") process.exitCode = 1;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original, sanitized diagnostic.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function applyNewsQualityMigrationAtomically(): Promise<void> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = 120000");
    await client.query("SET LOCAL lock_timeout = 10000");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    await client.query(
      "LOCK TABLE briefing_settings, briefing_stories IN ACCESS EXCLUSIVE MODE",
    );

    const query = async (sql: string, values: readonly unknown[]) => {
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as Array<Record<string, unknown>> };
    };
    const preflight = await inspectMigrationPreflight(query);
    console.log(formatMigrationPreflight(preflight));
    if (preflight.decision === "already-applied") {
      await client.query("COMMIT");
      inTransaction = false;
      console.log("News-quality migration was already applied; no changes made.");
      return;
    }
    if (preflight.decision !== "ready") {
      await client.query("ROLLBACK");
      inTransaction = false;
      process.exitCode = 1;
      console.error("Migration stopped before changes; preflight was not safe.");
      return;
    }

    const migrationSql = await readFile(
      resolve(
        process.cwd(),
        "lib/db/migrations/0001_briefline_news_quality.sql",
      ),
      "utf8",
    );
    await client.query(migrationSql);

    const schemaAfterMigration = await inspectBriefingSchema(query);
    if (
      schemaAfterMigration.missingColumns.length ||
      schemaAfterMigration.missingIndexes.length
    ) {
      throw new Error("Post-migration schema validation failed.");
    }
    const invalidBackfill = await client.query<{ invalid_rows: string }>(
      `SELECT COUNT(*)::text AS invalid_rows
         FROM briefing_stories
        WHERE revision_key IS NULL
           OR event_key IS NULL
           OR original_title IS NULL
           OR revision_key <> source_id
           OR event_key <> 'legacy:' || source_id
           OR original_title <> title`,
    );
    if (Number(invalidBackfill.rows[0]?.invalid_rows ?? "0") !== 0) {
      throw new Error("Post-migration data validation failed.");
    }

    await client.query("COMMIT");
    inTransaction = false;
    console.log(
      `News-quality migration committed atomically; derived fields backfilled for ${preflight.storiesToBackfill ?? 0} existing stories. No existing story fields were overwritten.`,
    );
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original, sanitized diagnostic.
      }
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function formatMigrationPreflight(preflight: Awaited<ReturnType<typeof inspectMigrationPreflight>>): string {
  return [
    `decision=${preflight.decision}`,
    `missing_tables=${preflight.missingTables.length ? preflight.missingTables.join(",") : "none"}`,
    `present_target_columns=${preflight.presentTargetColumns.length ? preflight.presentTargetColumns.join(",") : "none"}`,
    `present_target_indexes=${preflight.presentTargetIndexes.length ? preflight.presentTargetIndexes.join(",") : "none"}`,
    `invalid_target_indexes=${preflight.invalidTargetIndexes.length ? preflight.invalidTargetIndexes.join(",") : "none"}`,
    `conflicting_indexes=${preflight.conflictingIndexLocations.length ? preflight.conflictingIndexLocations.join(",") : "none"}`,
    `legacy_source_unique_index=${preflight.legacySourceUniqueIndexPresent ? "present" : "absent"}`,
    `legacy_index_is_constraint=${preflight.legacySourceIndexOwnedByConstraint ? "yes" : "no"}`,
    `duplicate_source_ids=${preflight.hasDuplicateSourceIds === null ? "not-checked" : preflight.hasDuplicateSourceIds ? "yes" : "no"}`,
    `invalid_legacy_values=${preflight.invalidLegacyValues ?? "not-checked"}`,
    `stories_to_backfill=${preflight.storiesToBackfill ?? "not-checked"}`,
  ].join(" ");
}

async function checkDatabaseSchemaReadOnly(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 3000");
    const inspection = await inspectBriefingSchema(async (sql, values) => {
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as Array<Record<string, unknown>> };
    });
    await client.query("COMMIT");

    if (inspection.missingColumns.length || inspection.missingIndexes.length) {
      console.log(
        `Read-only database schema check: missing columns [${inspection.missingColumns.join(", ")}]; missing indexes [${inspection.missingIndexes.join(", ")}].`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      "Read-only database schema check: all required Briefline columns and indexes are present.",
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original, sanitized diagnostic.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (migrationPreflightMode) {
    await runReadOnlyMigrationPreflight();
    return;
  }
  if (applyMigrationMode) {
    await applyNewsQualityMigrationAtomically();
    return;
  }
  if (schemaCheckMode) {
    await checkDatabaseSchemaReadOnly();
    return;
  }

  let client;
  let locked = false;
  try {
    client = await pool.connect();
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [ADVISORY_LOCK_ID],
    );
    locked = Boolean(result.rows[0]?.acquired);
    if (!locked) {
      console.log("Another scheduled run is active; this run exited without sending.");
      return;
    }

    const username = await getTelegramBotUsername();
    if (!username) throw new Error("Telegram bot identity unavailable.");
    const updates = await pollTelegramUpdatesOnce();
    await runScheduledJob();
    console.log(`Scheduled run complete. Telegram updates processed: ${updates}.`);
  } finally {
    if (client && locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
      } finally {
        client.release();
      }
    } else {
      client?.release();
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = migrationPreflightMode
    ? "Read-only migration preflight failed"
    : applyMigrationMode
      ? "Additive news-quality migration failed"
      : schemaCheckMode
        ? "Read-only database schema check failed"
        : "Scheduled Telegram job failed";
  console.error(`${message} (${safeErrorSummary(error)}).`);
  process.exitCode = 1;
});
