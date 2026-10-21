export function redactBotToken(value: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? value.replaceAll(token, "[redacted]") : value;
}
