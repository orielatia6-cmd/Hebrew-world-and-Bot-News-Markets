import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load, story } from "./harness.mjs";

async function schedulerFixture(t) {
  const f = fixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-07-01T05:00:00Z") }); // 08:00 Israel summer slot
  let refreshes = 0;
  const scheduler = await load("lib/briefing/scheduler.ts", {
    ...f.mocks,
    news: { refreshNews: async () => { refreshes++; return { fetched: 0, analyzed: 0, newStories: 0 }; } },
    telegram: { sendTelegramMessage: async (chatId, text) => {
      if (f.failSend) throw new Error("Telegram unavailable");
      f.sent.push({ chatId, text });
    } },
  }, { "scheduler.ts": ["dispatchPendingStories", "schedulerTick"] });
  return { ...scheduler, f, refreshes: () => refreshes };
}

test("scheduled slot sends at boundary, not before; only recent eligible undelivered stories", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push(story(1, 3), story(2, 4), story(3, 5), { ...story(4, 5), deliveredAt: new Date() });
  f.stories.push({ ...story(5, 5), publishedAt: new Date("2026-06-28T04:00:00Z") });
  t.mock.timers.setTime(Date.parse("2026-07-01T04:59:59.999Z"));
  assert.equal(await dispatchPendingStories(), 0);
  assert.equal(f.sent.length, 0);
  t.mock.timers.setTime(Date.parse("2026-07-01T05:00:00Z"));
  assert.equal(await dispatchPendingStories(), 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.stories[0].deliveredAt, null);
  assert.ok(f.stories[1].deliveredAt instanceof Date);
  assert.ok(f.stories[2].deliveredAt instanceof Date);
  assert.equal(f.stories[4].deliveredAt, null);
  assert.ok(f.settings.lastSentAt instanceof Date);
  assert.match(f.sent[0].text, /תדרוך חדשות חשוב/);
  assert.match(f.sent[0].text, /פורסם:/);
  assert.match(f.sent[0].text, /מה קרה \(לפי המקור\):/);
  assert.match(f.sent[0].text, /השפעה אפשרית על השוק \(ניתוח\):/);
  assert.match(f.sent[0].text, /מקור: BBC World\nhttps:\/\/example\.test\/2/);
  assert.equal(await dispatchPendingStories(), 0);
});

test("paused or unpaired delivery does not consume stories; resume delivers", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push(story(1));
  f.settings.enabled = false;
  assert.equal(await dispatchPendingStories(), 0);
  f.settings.enabled = true;
  f.settings.telegramChatId = null;
  assert.equal(await dispatchPendingStories(), 0);
  assert.equal(f.stories[0].deliveredAt, null);
  f.settings.telegramChatId = "101";
  assert.equal(await dispatchPendingStories(), 1);
});

test("failed send records error without marking delivery; next tick retries successfully", async (t) => {
  const { f, schedulerTick } = await schedulerFixture(t);
  f.stories.push(story(1));
  f.settings.lastCheckedAt = new Date(Date.now());
  f.failSend = true;
  await schedulerTick();
  assert.equal(f.settings.lastSentAt, null);
  assert.equal(f.stories[0].deliveredAt, null);
  assert.equal(f.settings.lastError, "Telegram unavailable");
  f.failSend = false;
  await schedulerTick();
  assert.equal(f.sent.length, 1);
  assert.ok(f.stories[0].deliveredAt instanceof Date);
  assert.equal(f.settings.lastError, null);
});

test("feed refresh cadence is fifteen minutes; no digest is sent outside a slot", async (t) => {
  const { f, schedulerTick, refreshes } = await schedulerFixture(t);
  t.mock.timers.setTime(Date.parse("2026-07-01T03:16:00Z"));
  f.settings.lastCheckedAt = new Date(Date.now() - 15 * 60_000 + 1);
  await schedulerTick();
  assert.equal(refreshes(), 0);
  f.settings.lastCheckedAt = new Date(Date.now() - 15 * 60_000);
  await schedulerTick();
  assert.equal(refreshes(), 1);
  assert.equal(f.settings.lastSentAt, null);
  assert.equal(f.sent.length, 0);
});

test("an empty scheduled digest is sent once per slot", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  assert.equal(await dispatchPendingStories(), 0);
  assert.equal(f.sent.length, 0, "no placeholder digest is sent when there is no important news");
  assert.equal(f.settings.lastSentAt, null, "a silent slot is not reported as a delivered digest");
  assert.ok(f.settings.lastProcessedDigestSlotAt instanceof Date);
  await dispatchPendingStories();
  assert.equal(f.sent.length, 0);
});

test("long story paragraphs are split without dropping text or exceeding Telegram limits", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  const longSummary = Array.from({ length: 500 }, (_, index) => `פרט${index}.`).join(" ");
  f.stories.push({ ...story(1), summary: longSummary });

  assert.equal(await dispatchPendingStories(), 1);
  assert.ok(f.sent.length > 1, "long item should be delivered in multiple messages");
  assert.ok(f.sent.every((message) => message.text.length <= 3_800));
  const allText = f.sent.map((message) => message.text).join("\n");
  for (let index = 0; index < 500; index += 1) {
    assert.ok(allText.includes(`פרט${index}.`), `missing source text token ${index}`);
  }
});

test("breaking alerts can send overnight without consuming the next scheduled slot or repeating stories", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  t.mock.timers.setTime(Date.parse("2026-07-01T22:00:00Z")); // 01:00 Israel
  f.stories.push(story(1, 5), story(2, 4), { ...story(3, 5), publishedAt: new Date(Date.now() - 3 * 60 * 60_000) });
  assert.equal(await dispatchPendingStories(false, true), 1);
  assert.equal(f.settings.lastSentAt, null);
  assert.match(f.sent[0].text, /התראת חדשות משמעותית/);
  assert.equal(await dispatchPendingStories(false, true), 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.stories[1].deliveredAt, null);
  assert.equal(f.stories[2].deliveredAt, null);
});
