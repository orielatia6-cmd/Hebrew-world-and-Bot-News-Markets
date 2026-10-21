import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load } from "./harness.mjs";

test("feeds deduplicate URLs/fragments and persisted stories before paid analysis", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-test-key";
  t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);
  const requests = [];
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "fixture feed" }));
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class { async parseString() {
      return { items: [
        { title: "News", link: "https://example.test/news#one" },
        { title: "News again", link: "https://example.test/news#two" },
        { title: "Invalid", link: "javascript:bad" },
        { title: "Old", link: "https://example.test/old", isoDate: "2000-01-01" },
      ] };
    } } },
    openai: { default: class {
      chat = { completions: { create: async (request) => {
        const candidates = JSON.parse(request.messages.find((message) => message.role === "user").content);
        requests.push(candidates);
        return { choices: [{ message: { content: JSON.stringify({
          stories: candidates.map((c) => ({
            sourceId: c.sourceId, title: "כותרת", summary: "סיכום", whyItMatters: "חשוב",
            marketImpact: "השפעה", importance: 3, tickers: [], sentiment: "neutral",
          })),
        }) } }] };
      } } };
    } },
  });
  const result = await news.refreshNews();
  assert.equal(result.newStories, 1);
  assert.equal(requests[0].length, 1);
  assert.equal(f.stories[0].importance, 3, "below-threshold stories remain available for later settings changes");
  assert.equal((await news.refreshNews()).newStories, 0);
  assert.equal(requests.length, 1, "seen stories must not incur another analysis call");
});

test("analysis rejects foreign IDs/non-Hebrew text and normalizes importance and tickers", async () => {
  const f = fixture();
  const news = await load("lib/briefing/news.ts", f.mocks, { "news.ts": ["parseAnalysis"] });
  const candidates = [{ sourceId: "known" }];
  const valid = { sourceId: "known", title: "כותרת", summary: "סיכום", whyItMatters: "חשוב", marketImpact: "השפעה" };
  assert.deepEqual(news.parseAnalysis({ stories: [{ ...valid, sourceId: "unknown" }] }, candidates), []);
  assert.deepEqual(news.parseAnalysis({ stories: [{ ...valid, summary: "English only" }] }, candidates), []);
  assert.deepEqual(news.parseAnalysis(null, candidates), []);
  for (const [input, expected] of [[0, 1], [3.5, 4], [4, 4], [9, 5], ["bad", 3]]) {
    const [analysis] = news.parseAnalysis({ stories: [{
      ...valid, importance: input, sentiment: "invalid", tickers: ["$nvda", "NVDA", "UNKNOWN"],
    }] }, candidates);
    assert.equal(analysis.importance, expected);
    assert.equal(analysis.sentiment, "neutral");
    assert.deepEqual(analysis.tickers, ["NVDA"]);
  }
});
