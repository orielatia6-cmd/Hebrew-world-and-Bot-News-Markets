
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Bot is running!");
    }

    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 403 });
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response("Bot not configured", { status: 503 });
    }

    try {
      const update = await request.json();
      const message = update.message;
      if (!message?.text) {
        return new Response("OK");
      }

      const command = message.text.split(" ")[0].split("@")[0];
      let reply;

      switch (command) {
        case "/start":
          reply = "שלום! ברוך הבא לבוט החדשות של אוריאל 📰";
          break;
        case "/status":
          reply = "✅ הבוט פעיל ומגיב לפקודות!";
          break;
        case "/help":
          reply = "פקודות זמינות: /start /status /help";
          break;
        default:
          return new Response("OK");
      }

      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: message.chat.id,
            text: reply
          })
        }
      );

      if (!response.ok) {
        return new Response("Telegram error", { status: 502 });
      }

      return new Response("OK");
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
  }
};
// Cloudflare deployment update