import { pool } from "@workspace/db";
import { runScheduledJob } from "./lib/briefing/scheduler";
import { digestSlot } from "./lib/briefing/schedule";
import { getTelegramBotUsername, pollTelegramUpdatesOnce } from "./lib/briefing/telegram";
import {
  inspectBriefingSchema,
  safeErrorSummary,
} from "./lib/briefing/diagnostics";

const ADVISORY_LOCK_ID = 7_842_190_631;
const schemaCheckMode = process.argv.includes("--schema-check");

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
  const message = schemaCheckMode
    ? "Read-only database schema check failed"
    : "Scheduled Telegram job failed";
  console.error(`${message} (${safeErrorSummary(error)}).`);
  process.exitCode = 1;
});
