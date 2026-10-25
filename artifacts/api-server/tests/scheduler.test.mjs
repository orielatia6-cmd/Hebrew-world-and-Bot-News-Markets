import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load, story } from "./harness.mjs";

function assertBalancedTelegramHtml(text) {
  const stack = [];
  const tags = text.match(/<\/?b>|<\/?a(?: href="[^"]*")?>/g) ?? [];
  for (const tag of tags) {
    const closing = tag.startsWith("</");
    const name = tag.match(/^<\/?([a-z]+)/i)?.[1]?.toLowerCase();
    assert.ok(name === "a" || name === "b", `unexpected HTML tag: ${tag}`);
    if (closing) assert.equal(stack.pop(), name, `unbalanced closing tag: ${tag}`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], "all HTML tags must close within the same Telegram message");
}

async function schedulerFixture(t) {
  const f = fixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-07-01T05:00:00Z") }); // 08:00 Israel summer slot
  let refreshes = 0;
  let sendAttempts = 0;
  const scheduler = await load("lib/briefing/scheduler.ts", {
    ...f.mocks,
    news: { refreshNews: async () => { refreshes++; return { fetched: 0, analyzed: 0, newStories: 0 }; } },
    telegram: { sendTelegramMessage: async (chatId, text, parseMode) => {
      sendAttempts++;
      if (f.failSend || f.failOnSendAttempt === sendAttempts) throw new Error("Telegram unavailable");
      f.sent.push({ chatId, text, parseMode });
    } },
  }, { "scheduler.ts": ["dispatchPendingStories", "schedulerTick"] });
  return { ...scheduler, f, refreshes: () => refreshes };
}

test("scheduled slot waits for its boundary after the prior slot; only recent eligible undelivered stories", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.settings.lastProcessedDigestSlotAt = new Date("2026-07-01T04:00:00Z");
  f.stories.push(
    story(1, 3),
    {
      ...story(2, 4),
      category: "markets",
      title: "כותרת 2",
      marketImpact: "הדיווח עשוי להשפיע על מדדי המניות בארצות הברית.",
    },
    {
      ...story(3, 5),
      category: "markets",
      title: "כותרת 3",
      marketImpact: "הדיווח עשוי להשפיע על מדדי המניות בארצות הברית.",
    },
    { ...story(4, 5), deliveredAt: new Date() },
  );
  f.stories.push({ ...story(5, 5), publishedAt: new Date("2026-06-28T04:00:00Z") });
  t.mock.timers.setTime(Date.parse("2026-07-01T04:59:59.999Z"));
  assert.equal(await dispatchPendingStories(), 0);
  assert.equal(f.sent.length, 0);
  t.mock.timers.setTime(Date.parse("2026-07-01T05:00:00Z"));
  assert.equal(await dispatchPendingStories(), 2);
  assert.equal(f.sent.length, 2);
  assert.equal(f.stories[0].deliveredAt, null);
  assert.ok(f.stories[1].deliveredAt instanceof Date);
  assert.ok(f.stories[2].deliveredAt instanceof Date);
  assert.equal(f.stories[4].deliveredAt, null);
  assert.ok(f.settings.lastSentAt instanceof Date);
  assert.match(f.sent[0].text, /כותרת 3/);
  assert.match(f.sent[1].text, /כותרת 2/);
  assert.ok(f.sent.every(({ text, parseMode }) =>
    parseMode === "HTML" &&
    /מה קרה/.test(text) &&
    /למה זה חשוב/.test(text) &&
    /השפעה אפשרית/.test(text) &&
    /🔗 <a href="https:\/\/example\.test\/\d+">מקור: BBC World<\/a>/.test(text) &&
    !/NEWS|AI ANALYSIS|AI RECOMMENDATION|POTENTIAL MARKET IMPACT|🕒|שעון ישראל/.test(text),
  ));
  assert.equal(await dispatchPendingStories(), 0);
});

test("each story is one concise Hebrew message with factual sections and a clickable source", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push(
    {
      ...story(1, 5),
      category: "markets",
      title: "כותרת <שוק> & בדיקה",
      summary: "המקור מתאר התפתחות בשוק. בדיווח מופיעים פרטים נוספים.",
      whyItMatters: "ההתפתחות עשויה להשפיע על ציפיות המשקיעים.",
      marketImpact: "מניות השבבים עשויות להגיב בהתאם לפרטי ההודעה.",
      sentiment: "positive",
      tickers: ["NVDA"],
      sourceName: "Reuters & Desk",
      url: "https://example.test/article?one=1&two=2",
    },
    {
      ...story(2, 4),
      category: "world",
      title: "התפתחות אזרחית",
      summary: "המקור מדווח על התפתחות אזרחית. פרטים נוספים מופיעים בדיווח.",
      whyItMatters: "ההתפתחות עשויה להשפיע על הקהילה המקומית.",
      marketImpact: "אין קשר ישיר לשוק על סמך המידע הזמין.",
      sentiment: "neutral",
      tickers: [],
    },
  );

  assert.equal(await dispatchPendingStories(), 2);
  assert.equal(f.sent.length, 2, "each story must be delivered in its own single message");
  const financialMessage = f.sent.find(({ text }) => text.includes("כותרת &lt;שוק&gt; &amp; בדיקה"));
  const nonfinancialMessage = f.sent.find(({ text }) => text.includes("התפתחות אזרחית"));
  assert.ok(financialMessage);
  assert.ok(nonfinancialMessage);
  assert.equal(financialMessage.parseMode, "HTML");
  assert.equal(nonfinancialMessage.parseMode, "HTML");
  assert.doesNotMatch(financialMessage.text, /🕒|שעון ישראל|תדרוכים/);
  assert.doesNotMatch(financialMessage.text, /\n{3,}/);
  for (const emoji of ["📊", "📰", "🧠", "📈", "🔗"]) {
    assert.equal((financialMessage.text.match(new RegExp(emoji, "gu")) ?? []).length, 1);
  }
  assert.doesNotMatch(financialMessage.text, /🔴/u);
  assert.equal((financialMessage.text.match(/כותרת/g) ?? []).length, 1);
  assert.doesNotMatch(financialMessage.text, /\.\s*;/);

  const headings = [
    "📰 <b>מה קרה:</b>",
    "🧠 <b>למה זה חשוב:</b>",
    "📈 <b>השפעה אפשרית:</b>",
    "🔗 <a href=",
  ];
  let previousIndex = -1;
  for (const heading of headings) {
    const index = financialMessage.text.indexOf(heading);
    assert.ok(index > previousIndex, `${heading} should appear in the required order`);
    previousIndex = index;
  }
  assert.match(financialMessage.text, /📈 <b>השפעה אפשרית:<\/b>\n.*\(NVDA\)/);
  assert.match(
    financialMessage.text,
    /🔗 <a href="https:\/\/example\.test\/article\?one=1&amp;two=2">מקור: Reuters &amp; Desk<\/a>/,
  );
  assert.match(financialMessage.text, /<b>📊 כותרת/);
  assert.match(nonfinancialMessage.text, /<b>🌍 התפתחות אזרחית/);
  assert.doesNotMatch(nonfinancialMessage.text, /השפעה אפשרית|אין קשר ישיר לשוק/);
  assert.doesNotMatch(financialMessage.text, /המלצה|קנייה|מכירה/);
});

test("long headlines are compacted and exact headline echoes are removed", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  const longHeadline =
    "שווקים בארצות הברית מגיבים להחלטת מדיניות חדשה לקראת סוף השבוע לאחר דיווח כלכלי משמעותי";
  f.stories.push({
    ...story(1, 4),
    title: longHeadline,
    summary: `${longHeadline}. הדיווח כולל גם נתונים על היקף ההכנסות.`,
  });

  assert.equal(await dispatchPendingStories(), 1);
  const message = f.sent[0].text;
  const title = message.match(/<b>(.*?)<\/b>/u)?.[1] ?? "";
  assert.ok(title.endsWith("…"));
  assert.ok(title.split(/\s+/u).filter(Boolean).length <= 12);
  assert.ok(message.includes("הדיווח כולל גם נתונים על היקף ההכנסות."));
  assert.ok(!message.includes(longHeadline));
  assert.doesNotMatch(message, /\n{3,}/);
  assertBalancedTelegramHtml(message);
});

test("Google News aggregator links are labeled as aggregators, not direct publisher articles", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push({
    ...story(1, 5),
    sourceName: "Reuters",
    url: "https://news.google.com/rss/articles/example-id",
  });

  assert.equal(await dispatchPendingStories(), 1);
  assert.match(
    f.sent[0].text,
    /🔗 <a href="https:\/\/news\.google\.com\/rss\/articles\/example-id">מקור: Reuters · דרך Google News<\/a>/,
  );
});

test("market impact is omitted unless it is specific and relevant to the story", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push(
    {
      ...story(1, 5),
      category: "world",
      title: "העיר פתחה מרכז חירום חדש",
      summary: "הרשות המקומית פתחה מרכז חירום לתושבים. השירות יפעל מסביב לשעון.",
      whyItMatters: "המרכז יספק מענה מהיר לתושבים בעת חירום.",
      marketImpact: "הדבר עשוי להשפיע על השווקים באופן כללי.",
    },
    {
      ...story(2, 5),
      category: "trump",
      title: "טראמפ הודיע על מכסים חדשים",
      summary: "טראמפ הודיע על מכסים חדשים על יבוא שבבים. ההחלטה תיכנס לתוקף בחודש הבא.",
      whyItMatters: "המכסים עשויים לשנות את עלויות היבוא של יצרניות שבבים.",
      marketImpact: "מניות השבבים עלולות להיפגע אם העלויות יעלו.",
      tickers: ["NVDA"],
    },
    {
      ...story(3, 5),
      category: "markets",
      title: "הפד פרסם הודעה",
      summary: "הבנק המרכזי פרסם הודעה לאחר ישיבתו. הוא לא שינה את הריבית.",
      whyItMatters: "ההודעה מספקת למשקיעים מידע על עמדת הבנק.",
      marketImpact: "ההודעה עשויה להשפיע על השוק.",
    },
  );

  assert.equal(await dispatchPendingStories(), 3);
  const unrelated = f.sent.find(({ text }) => text.includes("מרכז חירום"));
  const trump = f.sent.find(({ text }) => text.includes("טראמפ הודיע"));
  const boilerplateMarket = f.sent.find(({ text }) => text.includes("הפד פרסם"));
  assert.ok(unrelated && trump && boilerplateMarket);
  assert.doesNotMatch(unrelated.text, /📈 <b>השפעה אפשרית/);
  assert.match(trump.text, /📈 <b>השפעה אפשרית/);
  assert.doesNotMatch(boilerplateMarket.text, /📈 <b>השפעה אפשרית/);
});

test("urgent alerts use the same concise layout but are clearly separated from hourly digests", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  f.stories.push({
    ...story(1, 5),
    category: "markets",
    title: "הפד הודיע על שינוי בריבית",
    summary: "הפד הוריד את הריבית. ההחלטה פורסמה לאחר ישיבה מיוחדת.",
    whyItMatters: "ההחלטה משנה את עלות האשראי במשק.",
    marketImpact: "המדדים עשויים לעלות אם ההחלטה תומכת בצמיחה.",
  });

  assert.equal(await dispatchPendingStories(false, true), 1);
  assert.match(f.sent[0].text, /^🚨 <b>עדכון דחוף<\/b>\n\n<b>📊 /);
  for (const section of ["📰 <b>מה קרה:</b>", "🧠 <b>למה זה חשוב:</b>", "📈 <b>השפעה אפשרית:</b>", "🔗 <a href="]) {
    assert.ok(f.sent[0].text.includes(section), `urgent message must include ${section}`);
  }
  assert.doesNotMatch(f.sent[0].text, /🕒|שעון ישראל/);
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

test("oversized stories split into valid HTML messages without losing text", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  const longSummary = Array.from({ length: 500 }, (_, index) => `פרט${index}.`).join(" ");
  f.stories.push({ ...story(1), title: "כותרת בדיקה קצרה", summary: longSummary });

  assert.equal(await dispatchPendingStories(), 1);
  assert.ok(f.sent.length > 1, "the long story should be sent as multiple messages");
  assert.ok(f.sent.every(({ text, parseMode }) =>
    parseMode === "HTML" && text.length <= 3_800,
  ));
  for (const { text } of f.sent) assertBalancedTelegramHtml(text);
  const allText = f.sent.map(({ text }) => text).join("");
  for (let index = 0; index < 500; index += 1) {
    assert.ok(allText.includes(`פרט${index}.`), `missing source text token ${index}`);
  }
  assert.ok(allText.includes("<b>🌍 כותרת בדיקה קצרה</b>"));
  assert.ok(f.stories[0].deliveredAt instanceof Date);
});

test("a failed multipart send leaves the story pending until every part is delivered", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  const longSummary = Array.from({ length: 500 }, (_, index) => `פרט${index}.`).join(" ");
  f.stories.push({ ...story(1), summary: longSummary });
  f.failOnSendAttempt = 2;

  await assert.rejects(dispatchPendingStories(), /Telegram unavailable/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.stories[0].deliveredAt, null);

  f.failOnSendAttempt = null;
  assert.equal(await dispatchPendingStories(), 1);
  assert.ok(f.stories[0].deliveredAt instanceof Date);
  assert.ok(f.sent.length > 2, "retry sends all parts; previously accepted parts may be repeated");
});

test("breaking alerts can send overnight without consuming the next scheduled slot or repeating stories", async (t) => {
  const { f, dispatchPendingStories } = await schedulerFixture(t);
  t.mock.timers.setTime(Date.parse("2026-07-01T22:00:00Z")); // 01:00 Israel
  f.stories.push(
    {
      ...story(1, 5),
      category: "markets",
      marketImpact: "המדדים עשויים להגיב בהתאם לפרטי ההחלטה.",
    },
    story(2, 4),
    { ...story(3, 5), publishedAt: new Date(Date.now() - 3 * 60 * 60_000) },
  );
  assert.equal(await dispatchPendingStories(false, true), 1);
  assert.equal(f.settings.lastSentAt, null);
  assert.match(f.sent[0].text, /^🚨 <b>עדכון דחוף<\/b>/);
  assert.match(f.sent[0].text, /📰 <b>מה קרה:/);
  assert.match(f.sent[0].text, /📈 <b>השפעה אפשרית:/);
  assert.equal(await dispatchPendingStories(false, true), 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.stories[1].deliveredAt, null);
  assert.equal(f.stories[2].deliveredAt, null);
});
