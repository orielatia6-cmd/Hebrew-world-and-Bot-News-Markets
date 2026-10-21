import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load } from "./harness.mjs";

async function telegramFixture(t) {
  const f = fixture();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "fake-test-token";
  t.after(() => oldToken === undefined ? delete process.env.TELEGRAM_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN = oldToken);
  const timeouts = [];
  let refreshes = 0;
  t.mock.method(AbortSignal, "timeout", (ms) => { timeouts.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.body) f.sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: [] }) };
  });
  const telegram = await load("lib/briefing/telegram.ts", {
    ...f.mocks,
    scheduler: { refreshAndDeliver: async () => {
      refreshes++;
      return { analyzed: 1, newStories: 1 };
    } },
  }, { "telegram.ts": ["handleUpdate", "telegramCall"] });
  const update = (id, text, type = "private") => telegram.handleUpdate({
    update_id: 1, message: { text, chat: { id, type } },
  });
  return { f, telegram, update, timeouts, refreshes: () => refreshes };
}

test("only the first private chat pairs; non-owner commands cannot modify settings", async (t) => {
  const { f, update } = await telegramFixture(t);
  f.settings.telegramChatId = null;
  await update(101, "/start", "group");
  assert.equal(f.settings.telegramChatId, null);
  await update(101, "/start");
  assert.equal(f.settings.telegramChatId, "101");
  await update(202, "/start");
  assert.equal(f.settings.telegramChatId, "101");
  await update(202, "/pause");
  await update(202, "/interval 15");
  await update(202, "/importance 3");
  assert.equal(f.settings.enabled, true);
  assert.equal(f.settings.deliveryIntervalMinutes, 360);
  assert.equal(f.settings.minImportance, 4);
  await update(101, "/pause");
  assert.equal(f.settings.enabled, false);
  await update(202, "/resume");
  assert.equal(f.settings.enabled, false);
  await update(101, "/resume");
  assert.equal(f.settings.enabled, true);
});

test("legacy interval commands cannot change the eight-digest schedule; importance remains adjustable", async (t) => {
  const { f, update } = await telegramFixture(t);
  for (const input of ["15", "30", "60", "120", "360", "0", "bad", ""]) {
    await update(101, `/interval ${input}`);
    assert.equal(f.settings.deliveryIntervalMinutes, 360);
    for (const hour of ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"]) {
      assert.ok(f.sent.at(-1).text.includes(hour));
    }
  }
  for (const importance of [3, 4, 5]) {
    await update(101, `/importance ${importance}`);
    assert.equal(f.settings.minImportance, importance);
  }
  await update(101, "/importance 2");
  assert.equal(f.settings.minImportance, 5);
});

test("manual refresh throttles for five minutes, rejects outsiders, and resets at boundary", async (t) => {
  const { update, refreshes } = await telegramFixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  await update(202, "/refresh");
  assert.equal(refreshes(), 0);
  await update(101, "/refresh");
  assert.equal(refreshes(), 1);
  t.mock.timers.setTime(1_299_999);
  await update(101, "/refresh");
  assert.equal(refreshes(), 1);
  t.mock.timers.setTime(1_300_000);
  await update(101, "/refresh");
  assert.equal(refreshes(), 2);
});

test("long polling has a longer timeout than Telegram's wait; failed sends throw", async (t) => {
  const { telegram, timeouts } = await telegramFixture(t);
  await telegram.telegramCall("getUpdates?offset=0&timeout=25");
  assert.equal(timeouts.at(-1), 35_000);
  await telegram.sendTelegramMessage("101", "בדיקה");
  assert.equal(timeouts.at(-1), 15_000);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false, json: async () => ({ ok: false, description: "delivery failed" }),
  }));
  await assert.rejects(telegram.sendTelegramMessage("101", "בדיקה"), /delivery failed/);
});
