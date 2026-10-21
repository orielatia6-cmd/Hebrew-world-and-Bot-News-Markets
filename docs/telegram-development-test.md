# Temporary Telegram-only test

This opt-in process uses the existing Telegram secret internally. It does not import the database, scheduler, RSS, or OpenAI modules and does not save chat ownership or settings.

## Before starting

Confirm that no production deployment or other host is polling this bot. Do not publish while the test runs. The ordinary development API workflow does not poll.

The runner refuses production mode, a different bot identity, an active webhook, or a local polling lock. It stops on Telegram conflict errors instead of retrying. A local lock cannot prevent an unknown remote host from using the token.

During this test, old queued commands and unsupported commands are ignored and acknowledged, not executed. Send a fresh `/start` after the READY message. The first private chat to do so owns this temporary session only.

## Start

In the Replit Shell at the project root:

```sh
pnpm --filter @workspace/api-server run telegram:test
```

Wait for `READY`. Open the existing bot in Telegram and send `/start`, then `/test`. The welcome response explicitly says this is a temporary test with no website login. `/refresh`, `/resume`, and other commands cannot start news or AI work.

## Stop

Send `/stoptest` from that same Telegram chat, or press Ctrl+C in the Shell running the command. Wait for `STOPPED` and the shell prompt. The process also exits automatically after 15 minutes. No environment flag or credential needs to be reverted.

SIGTERM also stops and releases the lock. An unclean kill can leave a lock in the workspace's ignored `.local/telegram-poller-locks` directory; the runner deliberately refuses to steal it. Ask for inspection before removing a stale lock, and do not force a second poller. This workspace-shared directory coordinates the shell runner with the managed API process even if they have different temporary directories.

This test does not activate continuous hosting or the saved eight-digest schedule. Normal production behavior remains unchanged apart from the shared local single-poller lock. Existing Replit compute usage may still apply; no paid service is installed or purchased.
