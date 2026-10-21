import { pool } from "@workspace/db";
import { runScheduledJob } from "./lib/briefing/scheduler";
import { digestSlot } from "./lib/briefing/schedule";
import { getTelegramBotUsername, pollTelegramUpdatesOnce } from "./lib/briefing/telegram";

const ADVISORY_LOCK_ID = 7_842_190_631;

async function main(): Promise<void> {
  let client;
  let locked = false;
  try {
    // Only the four UTC trigger times map to digest slots in Israel. Verify the
    // local slot before contacting Neon, Telegram, news sources, or OpenAI.
    if (!digestSlot(new Date(), null)) {
      console.log("Not an Israel digest slot; no Telegram, database, news, or AI work performed.");
      return;
    }
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

main().catch(() => {
  // Do not print database or Telegram exceptions; they may contain credentials.
  console.error("Scheduled Telegram job failed; inspect the run status without sharing secrets.");
  process.exitCode = 1;
});
