import app from "./app";
import { logger } from "./lib/logger";
import { startBriefingScheduler } from "./lib/briefing/scheduler";
import { startTelegramPolling } from "./lib/briefing/telegram";
import { acquirePollerLock } from "./lib/briefing/poller-lock";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  if (process.env.NODE_ENV === "production") {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("Telegram secret unavailable; bot startup refused.");
    const release = acquirePollerLock(token);
    process.once("exit", release);
    process.once("SIGINT", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
    startBriefingScheduler();
    startTelegramPolling();
  } else {
    logger.info(
      "Telegram polling and scheduled news delivery are disabled in development to avoid competing with the published bot.",
    );
  }
});
