import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load, story } from "./harness.mjs";

async function schedulerFixture(t) {
  const f = fixture();
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000_000_000 });
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

test("six-hour cadence sends at boundary, not before; only eligible undelivered stories", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push(story(1, 3), story(2, 4), story(3, 5), { ...story(4, 5), deliveredAt: new Date() });
  f.settings.lastSentAt = new Date(Date.now() - 360 * 60_000 + 1);
  assert.equal(await dispatchPendingStories(), 0);
  assert.equal(f.sent.length, 0);
  f.settings.lastSentAt = new Date(Date.now() - 360 * 60_000);
  assert.equal(await dispatchPendingStories(), 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.stories[0].deliveredAt, null);
  assert.ok(f.stories[1].deliveredAt instanceof Date);
  assert.ok(f.stories[2].deliveredAt instanceof Date);
  assert.ok(f.settings.lastSentAt instanceof Date);
  assert.match(f.sent[0].text, /תדרוך חדשות חשוב/);
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

test("feed refresh cadence is fifteen minutes; empty digest does not advance delivery", async (t) => {
  const { f, schedulerTick, refreshes } = await schedulerFixture(t);
  f.settings.lastCheckedAt = new Date(Date.now() - 15 * 60_000 + 1);
  await schedulerTick();
  assert.equal(refreshes(), 0);
  f.settings.lastCheckedAt = new Date(Date.now() - 15 * 60_000);
  await schedulerTick();
  assert.equal(refreshes(), 1);
  assert.equal(f.settings.lastSentAt, null);
  assert.equal(f.sent.length, 0);
});
