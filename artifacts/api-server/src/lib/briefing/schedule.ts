export const SCHEDULE_HEBREW = "07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00, 21:00 (שעון ישראל)";
export function digestSlot(now: Date, lastSent: Date | null): Date | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  if (![7, 9, 11, 13, 15, 17, 19, 21].includes(hour) || minute >= 15) return null;
  const slot = new Date(now.getTime() - minute * 60000 - now.getSeconds() * 1000 - now.getMilliseconds());
  return lastSent && lastSent >= slot ? null : slot;
}

export function similarHeadline(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().replace(/\s[-–|]\s[^–|]+$/, "").match(/[\p{L}\p{N}]+/gu) ?? []);
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return false;
  const overlap = [...left].filter(w => right.has(w)).length;
  return overlap / new Set([...left, ...right]).size >= 0.8;
}
