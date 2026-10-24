# GitHub Actions + Neon migration (manual setup required)

GitHub starts the job every 15 minutes. The application checks 24 hourly digest
slots in Israel time and checks for breaking stories on each run. GitHub can
delay or skip scheduled starts, so this is best-effort and not an on-time SLA.

## Before enabling

1. Create a **private** GitHub repository and push the existing project source
   to it. Use the Replit Git pane or GitHub's official import flow. Do not
   commit `.env` files, database dumps, tokens, or API keys.
2. Create a Neon project on its Free plan. Keep the database endpoint/private
   connection string only in secure settings.
3. Add these Actions repository secrets: `DATABASE_URL` (Neon connection
   string with SSL required), `TELEGRAM_BOT_TOKEN`, and `OPENAI_API_KEY`.
   Never put credential values in workflow YAML, commits, logs, or chat.
4. From the repository's Actions tab, run **Initialize Briefline Neon schema**,
   enter `INITIALIZE`, and verify the tables were created. This action is
   manual only; scheduled jobs never run schema updates.
5. Run the scheduled workflow once with **Run workflow** to verify a successful
   execution. The first `/start` against empty Neon settings pairs the owner.

## Schedule and behavior

- The application preserves 24 hourly digest slots using `Asia/Jerusalem`,
  including daylight-saving changes. A digest is sent only during its first
  15-minute window; a delayed GitHub run can miss that slot.
- Breaking stories and source refreshes are checked when each scheduled job
  runs, nominally every 15 minutes; these alerts are not instant.
- Telegram commands are checked in a bounded batch once per run. Responses
  usually wait for the next run and may be delayed or skipped by GitHub. The
  persisted update offset lets a later run continue after the last handled update.
- `/pause`, `/resume`, `/importance`, `/status`, `/schedule`, `/test`, and
  `/refresh` remain available after their updates are polled. There is no
  continuously available HTTP server, health endpoint, or live polling loop.
- A Neon advisory lock prevents overlapping jobs. Story source IDs, unique
  constraints, recent Hebrew headline matching, delivery flags, and
  `lastSentAt` continue to suppress duplicate stories/digests. If Telegram
  accepts a message and the process dies before its database acknowledgement,
  that narrow failure window can still produce a repeated Telegram reply.
- The Neon database begins empty. Existing owner settings, source-health rows,
  story history, and delivery records are not copied automatically. Re-pair
  with `/start`; without importing old story history, a recent article could
  appear again during the first 48 hours.

## Cost and usage

GitHub Actions minutes, Neon Free compute/storage quota, RSS provider
availability, and OpenAI API billing are separate. The OpenAI API remains
usage-billed; the current code calls GPT-5 mini only when there are new stories
to analyze. This migration does not disable that charge. No Neon resource or
GitHub secret is created by the code changes.
