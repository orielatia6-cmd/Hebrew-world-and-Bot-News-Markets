# GitHub Actions + Neon migration (manual setup required)

This is a four-digest-per-day, best-effort design. GitHub runs at 05:05, 09:05,
13:05, and 17:05 UTC. These map to 07:05, 11:05, 15:05, and 19:05 Israel time
in winter, and 08:05, 12:05, 16:05, and 20:05 in summer. Starts can be delayed
or skipped by GitHub, so this is not an on-time delivery SLA.

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

- The bot sends up to four digests per day, with send times shifting by one
  hour between Israel winter and summer time. The workflow is triggered at
  minute 05; GitHub can still delay or miss starts, and the digest window is
  15 minutes.
- Breaking stories are checked only when the scheduled job runs; they are not
  instant. Feed scans also happen at those four executions, not every 15
  minutes.
- Telegram commands are checked in a bounded batch once per run. Responses may
  be delayed by hours. The persisted update offset lets the next run continue
  after the last successfully handled update.
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
