import { acquirePollerLock } from "./poller-lock";

export function testReply(command: string): string {
  if (command === "/start") return "בדיקה זמנית של Briefline פעילה.\nאין צורך בקוד כניסה או באתר.\nשלח /test לבדיקת מסירה או /stoptest לסיום.\nבבדיקה זו אין איסוף חדשות, תדרוכים מתוזמנים או שימוש ב־OpenAI. לוח שמונת התדרוכים נשאר ללא שינוי.";
  if (command === "/test") return "בדיקת מסירת הודעה הצליחה. זוהי הודעת בדיקה בלבד, ללא שימוש ב־OpenAI.";
  if (command === "/stoptest") return "הבדיקה הזמנית מסתיימת כעת. לא שונו ההגדרות או לוח שמונת התדרוכים.";
  return "בבדיקה זמנית זמינות רק הפקודות /start, /test ו־/stoptest. חדשות ו־OpenAI כבויים.";
}

export async function runDevTest(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Temporary test refused in production.");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("The existing Telegram secret is unavailable. No test started.");
  const release = acquirePollerLock(token);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(stop, 15 * 60 * 1000);
  const started = Math.floor(Date.now() / 1000);
  let owner: number | undefined;
  let offset = 0;
  let stopping = false;

  async function call(method: string, body: Record<string, unknown> = {}) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
    });
    const payload = await response.json() as { ok: boolean; error_code?: number; result?: any };
    if (response.status === 409 || payload.error_code === 409) {
      throw new Error("Telegram polling conflict detected. Test stopped; no webhook or credentials changed.");
    }
    if (!response.ok || !payload.ok) throw new Error("Telegram request failed. Test stopped; remote details withheld to protect credentials.");
    return payload.result;
  }

  try {
    const bot = await call("getMe");
    if (bot.username !== "Oriel_news_bot") throw new Error("Unexpected bot identity. Test refused.");
    const webhook = await call("getWebhookInfo");
    if (webhook.url) throw new Error("An active webhook exists. Test refused without changing it.");
    console.log("Temporary Telegram-only test READY for @Oriel_news_bot. Send a NEW /start now. Auto-stop: 15 minutes. Stop: Ctrl+C or /stoptest.");
    console.log("No database, news, scheduler, or OpenAI modules are loaded. Old queued commands are ignored and acknowledged during this test.");
    while (!controller.signal.aborted && !stopping) {
      const updates = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const update of updates) {
        const message = update.message;
        if (message?.chat?.type === "private" && message.date >= started && typeof message.text === "string") {
          const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
          if (owner === undefined && command === "/start") owner = message.chat.id;
          if (owner === message.chat.id && command.startsWith("/")) {
            await call("sendMessage", { chat_id: owner, text: testReply(command) });
            console.log(`Telegram accepted temporary ${["/start", "/test", "/stoptest"].includes(command) ? command : "disabled-command"} reply.`);
            if (command === "/stoptest") stopping = true;
          }
        }
        offset = update.update_id + 1;
        if (stopping) break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      // Never emit fetch errors or stack traces: they may contain token-bearing URLs.
      const safe = error instanceof Error && /^(Telegram polling conflict|Telegram request failed|Unexpected bot identity|An active webhook)/.test(error.message);
      throw new Error(safe ? (error as Error).message : "Temporary Telegram test failed safely. No raw network details logged.");
    }
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    release();
    console.log("Temporary Telegram test STOPPED. Polling lock released; saved settings unchanged.");
  }
}
