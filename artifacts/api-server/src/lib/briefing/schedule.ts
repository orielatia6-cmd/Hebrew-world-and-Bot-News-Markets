const UTC_DIGEST_HOURS = Array.from({ length: 24 }, (_, i) => i);

export function israelDigestHours(now: Date): number[] {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value.match(/GMT([+-]\d+)/)?.[1];
  if (!offset) throw new Error("Could not determine Israel's UTC offset.");
  return UTC_DIGEST_HOURS.map((hour) => (hour + Number(offset) + 24) % 24);
}

export function scheduleHebrew(now = new Date()): string {
  return `${israelDigestHours(now).map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")} (שעון ישראל)`;
}

export function digestSlot(now: Date, lastSent: Date | null): Date | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  if (!israelDigestHours(now).includes(hour) || minute >= 15) return null;
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
