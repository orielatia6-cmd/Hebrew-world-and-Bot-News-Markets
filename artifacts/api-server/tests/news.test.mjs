import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load } from "./harness.mjs";

test("feeds deduplicate URLs/fragments and persisted stories before paid analysis", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-test-key";
  t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);
  const requests = [];
  const clientOptions = [];
  const analysisRequests = [];
  const parserOptions = [];
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "fixture feed" }));
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class {
      constructor(options) { parserOptions.push(options); }
      async parseString() {
      return { items: [
        { title: "News", link: "https://example.test/news#one", isoDate: new Date().toISOString(), source: "Reuters" },
        { title: "News again", link: "https://example.test/news#two", isoDate: new Date().toISOString(), source: "Reuters" },
        { title: "Invalid", link: "javascript:bad" },
        { title: "Old", link: "https://example.test/old", isoDate: "2000-01-01" },
      ] };
    } } },
    openai: { default: class {
      constructor(options) { clientOptions.push(options); }
      chat = { completions: { create: async (request) => {
        analysisRequests.push(request);
        const candidates = JSON.parse(request.messages.find((message) => message.role === "user").content);
        requests.push(candidates);
        return { choices: [{ message: { content: JSON.stringify({
          stories: candidates.map((c) => ({
            sourceId: c.sourceId, title: "כותרת", summary: "המקור מתאר את האירוע. הפרטים מופיעים בדיווח.", whyItMatters: "חשוב",
            marketImpact: "השפעה", importance: 3, tickers: [], sentiment: "neutral",
            eventKey: "", materialUpdate: false,
          })),
        }) } }] };
      } } };
    } },
  });
  const result = await news.refreshNews();
  assert.equal(result.newStories, 1);
  assert.equal(clientOptions[0].timeout, 90_000);
  assert.equal(clientOptions[0].maxRetries, 2);
  assert.deepEqual(parserOptions[0].customFields.item, [["source", "source"]]);
  assert.equal(analysisRequests[0].model, "gpt-5-mini");
  assert.equal(requests[0].length, 1);
  assert.equal(requests[0][0].source, "Reuters");
  assert.equal(f.stories[0].sourceName, "Reuters");
  assert.equal(f.stories[0].importance, 3, "below-threshold stories remain available for later settings changes");
  assert.equal((await news.refreshNews()).newStories, 0);
  assert.equal(requests.length, 1, "seen stories must not incur another analysis call");
});

test("an OpenAI request timeout is identified as an analysis timeout without exposing credentials", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-test-key";
  t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);

  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "fixture feed" }));
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class { async parseString() {
       return { items: [{ title: "New story", link: "https://example.test/new-story", isoDate: new Date().toISOString() }] };
    } } },
    openai: { default: class {
      constructor(options) { assert.equal(options.timeout, 90_000); }
      chat = { completions: { create: async () => { throw new Error("Request timed out."); } } };
    } },
  });

  await assert.rejects(news.refreshNews(), /OpenAI news analysis request timed out after 90 seconds/);
});

test("a failed feed is recorded without blocking stories from healthy feeds", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-test-key";
  t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);

  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: !url.includes("feeds.bbci.co.uk"),
    status: 503,
    text: async () => url,
  }));
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class { async parseString(feedUrl) {
       return { items: [{ title: "News", link: `https://example.test/${encodeURIComponent(feedUrl)}`, isoDate: new Date().toISOString() }] };
    } } },
    openai: { default: class {
      chat = { completions: { create: async (request) => {
        const candidates = JSON.parse(request.messages.find((message) => message.role === "user").content);
        return { choices: [{ message: { content: JSON.stringify({
          stories: candidates.map((candidate) => ({
            sourceId: candidate.sourceId, title: "כותרת חדשות", summary: "המקור מתאר את האירוע. הפרטים מופיעים בדיווח.",
            whyItMatters: "חשוב", marketImpact: "השפעה", importance: 3,
            eventKey: "", materialUpdate: false,
            tickers: [], sentiment: "neutral",
          })),
        }) } }] };
      } } };
    } },
  });

  const result = await news.refreshNews();
  assert.equal(result.newStories, 3, "similar low-information headlines are collapsed within each category");
  assert.equal(f.feedHealth.length, 11);
  const failed = f.feedHealth.find((source) => source.name === "BBC World");
  assert.equal(failed.lastError, "HTTP 503");
  assert.equal(failed.lastSuccessfulFetch, null);
  const healthy = f.feedHealth.filter((source) => source.name !== "BBC World");
  assert.equal(healthy.length, 10);
  assert.ok(healthy.every((source) => source.lastSuccessfulFetch instanceof Date));
  assert.ok(healthy.every((source) => source.recentStoryCount === 1));
  const healthResponse = await news.getNewsSourceHealth();
  assert.equal(healthResponse.length, 11);
  assert.equal(
    healthResponse.find((source) => source.name === "BBC World").lastError,
    "HTTP 503",
  );
  assert.deepEqual(
    healthResponse.filter((source) => source.name.startsWith("Yahoo Finance")).map((source) => source.name),
    ["Yahoo Finance — S&P 500", "Yahoo Finance — מניות טכנולוגיה"],
  );
});

test("invalid, missing, old, and future publication dates are rejected", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-test-key";
  t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);
  const now = Date.now();
  const analyzedCandidates = [];
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "fixture feed" }));
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class { async parseString() {
      return { items: [
        { title: "No date", link: "https://example.test/no-date" },
        { title: "Bad date", link: "https://example.test/bad-date", isoDate: "not-a-date" },
        { title: "Old report", link: "https://example.test/old-date", isoDate: "2000-01-01" },
        { title: "Future report", link: "https://example.test/future-date", isoDate: new Date(now + 60 * 60_000).toISOString() },
        { title: "Fresh market news", link: "https://example.test/fresh", isoDate: new Date(now - 5 * 60_000).toISOString(), contentSnippet: "Federal Reserve policy update." },
      ] };
    } } },
    openai: { default: class {
      chat = { completions: { create: async (request) => {
        const candidates = JSON.parse(request.messages.find((message) => message.role === "user").content);
        analyzedCandidates.push(...candidates);
        return { choices: [{ message: { content: JSON.stringify({
          stories: candidates.map((candidate) => ({
            sourceId: candidate.sourceId, title: "חדשות שוק", summary: "הבנק המרכזי פרסם עדכון. ההודעה כוללת פרטים על החלטתו.",
            whyItMatters: "המידע עשוי להשפיע על ציפיות הריבית.", marketImpact: "השפעתו על המדדים אינה ודאית.",
            importance: 4, tickers: [], sentiment: "neutral", eventKey: "", materialUpdate: false,
          })),
        }) } }] };
      } } };
    } },
  });
  await news.refreshNews();
  assert.equal(analyzedCandidates.length, 1);
  assert.match(analyzedCandidates[0].title, /Fresh market news/);
});

test("factual number and quote validation rejects unsupported claims", async () => {
  const f = fixture();
  const news = await load("lib/briefing/news.ts", f.mocks, { "news.ts": ["parseAnalysis"] });
  const candidate = {
    sourceId: "known", title: "Fed rate decision", articleContext: "The Federal Reserve held its rate at 5.25%.",
    priorReports: [],
  };
  const base = {
    sourceId: "known", title: "הפד הותיר את הריבית ללא שינוי",
    summary: "הפדרל ריזרב הותיר את הריבית על 5.25%. ההחלטה דווחה במקור.",
    whyItMatters: "ההחלטה משפיעה על עלות האשראי.",
    marketImpact: "התגובה במדדים תלויה בציפיות המשקיעים.",
    importance: 4, sentiment: "neutral", tickers: [],
  };
  assert.equal(news.parseAnalysis({ stories: [base] }, [candidate]).length, 1);
  assert.deepEqual(
    news.parseAnalysis({ stories: [{ ...base, summary: "הריבית נקבעה על 6.25%. פרטים נוספים מופיעים במקור." }] }, [candidate]),
    [],
  );
  assert.deepEqual(
    news.parseAnalysis({ stories: [{ ...base, summary: "הפד אמר ״ההחלטה מפתיעה״. פרטים נוספים מופיעים במקור." }] }, [candidate]),
    [],
  );
});

test("relevance ranking favors market-moving topics and reputable sources", async () => {
  const f = fixture();
  const news = await load("lib/briefing/news.ts", f.mocks, { "news.ts": ["candidatePriority"] });
  const publishedAt = new Date();
  const priorityStory = {
    title: "Federal Reserve announces an interest rate decision",
    articleContext: "The FOMC published its policy decision.",
    sourceName: "Reuters", category: "markets", publishedAt,
  };
  const lowRelevanceStory = {
    title: "Local restaurant opens downtown",
    articleContext: "The cafe welcomed its first customers.",
    sourceName: "Local News", category: "world", publishedAt,
  };
  const yahooStory = {
    ...priorityStory,
    sourceName: "Yahoo Finance — S&P 500",
  };
  assert.ok(news.candidatePriority(priorityStory) > news.candidatePriority(lowRelevanceStory));
  assert.ok(news.candidatePriority(priorityStory) > news.candidatePriority(yahooStory));
  assert.ok(news.candidatePriority(yahooStory) > news.candidatePriority(lowRelevanceStory));
});

test("a previously reported event is suppressed unless the analysis marks a material update", async (t) => {
  for (const materialUpdate of [false, true]) {
    const f = fixture();
    f.stories.push({
      id: 1, sourceId: "old-source", revisionKey: "old-revision", eventKey: "fed-policy",
      originalTitle: "Federal Reserve holds interest rates after inflation report",
      title: "הפדרל ריזרב הותיר את הריבית ללא שינוי", summary: "הבנק המרכזי הותיר את הריבית.",
      whyItMatters: "ההחלטה משפיעה על ציפיות הריבית.", marketImpact: "ההשפעה על השוק אינה ודאית.",
      url: "https://reuters.com/old", sourceName: "Reuters", category: "markets",
      importance: 4, sentiment: "neutral", tickers: [], deliveredAt: new Date(),
      createdAt: new Date(), publishedAt: new Date(),
    });
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fake-test-key";
    t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "fixture feed" }));
    const news = await load("lib/briefing/news.ts", {
      ...f.mocks,
      "rss-parser": { default: class { async parseString() {
        return { items: [{
          title: "Federal Reserve holds interest rates after inflation report",
          link: "https://example.test/fed-update",
          isoDate: new Date().toISOString(),
          contentSnippet: "The Federal Reserve published a new policy statement today.",
        }] };
      } } },
      openai: { default: class {
        chat = { completions: { create: async (request) => {
          const candidates = JSON.parse(request.messages.find((message) => message.role === "user").content);
          assert.equal(candidates[0].previouslyReported[0].eventKey, "fed-policy");
          return { choices: [{ message: { content: JSON.stringify({
            stories: candidates.map((candidate) => ({
              sourceId: candidate.sourceId, eventKey: "fed-policy", materialUpdate,
              title: "עדכון של הפדרל ריזרב", summary: "הבנק המרכזי פרסם הצהרת מדיניות חדשה. המקור מפרט את תוכן ההצהרה.",
              whyItMatters: "הצהרה חדשה עשויה לשנות את ציפיות המשקיעים.",
              marketImpact: "התגובה במדדים תלויה בפרטי ההצהרה ובציפיות הקודמות.",
              importance: 4, tickers: [], sentiment: "neutral",
            })),
          }) } }] };
        } } };
      } },
    });
    const result = await news.refreshNews();
    assert.equal(result.newStories, 1);
    const savedRevision = f.stories.find((story) => story.id !== 1);
    assert.ok(savedRevision);
    assert.equal(savedRevision.eventKey, "fed-policy");
    assert.equal(savedRevision.deliveredAt instanceof Date, !materialUpdate);
  }
});

test("Google News links resolve only to safe direct HTTPS article links", async (t) => {
  const f = fixture();
  const news = await load("lib/briefing/news.ts", f.mocks, { "news.ts": ["directArticleLink"] });
  let destinations = ["https://www.reuters.com/world/example-story"];
  let fetchIndex = 0;
  t.mock.method(globalThis, "fetch", async () => ({
    headers: { get: () => destinations[fetchIndex++] ?? null },
  }));
  assert.equal(
    await news.directArticleLink("https://news.google.com/rss/articles/abc"),
    "https://www.reuters.com/world/example-story",
  );
  destinations = [
    "https://news.google.com/rss/articles/redirected",
    "https://www.reuters.com/world/multi-hop-story",
  ];
  fetchIndex = 0;
  assert.equal(
    await news.directArticleLink("https://news.google.com/rss/articles/abc"),
    "https://www.reuters.com/world/multi-hop-story",
    "follow only Google News redirect hops and return the verified HTTPS publisher destination",
  );
  destinations = ["http://127.0.0.1/admin"];
  fetchIndex = 0;
  assert.equal(
    await news.directArticleLink("https://news.google.com/rss/articles/abc"),
    "https://news.google.com/rss/articles/abc",
  );
  destinations = ["https://news.google.com/rss/articles/redirected", null];
  fetchIndex = 0;
  assert.equal(
    await news.directArticleLink("https://news.google.com/rss/articles/abc"),
    "https://news.google.com/rss/articles/abc",
    "keep the Google News URL when its redirect does not reach a verified publisher article",
  );
});

test("analysis rejects foreign IDs/non-Hebrew text and normalizes importance and tickers", async () => {
  const f = fixture();
  const news = await load("lib/briefing/news.ts", f.mocks, { "news.ts": ["parseAnalysis"] });
  const candidates = [{ sourceId: "known", priorReports: [] }];
  const valid = { sourceId: "known", title: "כותרת", summary: "הדיווח מתאר את האירוע. פרטים נוספים מופיעים במקור.", whyItMatters: "חשוב", marketImpact: "השפעה" };
  assert.deepEqual(news.parseAnalysis({ stories: [{ ...valid, sourceId: "unknown" }] }, candidates), []);
  assert.deepEqual(news.parseAnalysis({ stories: [{ ...valid, summary: "English only" }] }, candidates), []);
  assert.deepEqual(
    news.parseAnalysis({ stories: [{ ...valid, summary: "משפט עובדתי יחיד." }] }, candidates),
    [],
    "the factual section should contain at least two short sentences",
  );
  assert.deepEqual(
    news.parseAnalysis(
      {
        stories: [{
          ...valid,
          title: "כותרת אחת קצרה אך ארוכה מדי שנועדה לבדוק את מגבלת המילים החדשה עכשיו",
        }],
      },
      candidates,
    ),
    [],
    "analysis with a headline over 12 words must be rejected",
  );
  const fullerSummary = `${Array.from({ length: 41 }, () => "עובדה").join(" ")}. ${Array.from({ length: 40 }, () => "פרט").join(" ")}.`;
  assert.equal(
    news.parseAnalysis(
      { stories: [{ ...valid, summary: fullerSummary }] },
      candidates,
    ).length,
    1,
    "useful context is retained instead of being discarded for a word target",
  );
  assert.deepEqual(
    news.parseAnalysis(
      {
        stories: [{
          ...valid,
          whyItMatters: "האירוע חשוב.",
          marketImpact: "האירוע חשוב.",
        }],
      },
      candidates,
    ),
    [],
    "duplicate why-it-matters and impact text is rejected",
  );
  assert.deepEqual(news.parseAnalysis(null, candidates), []);
  assert.deepEqual(
    news.parseAnalysis(
      { stories: [{ ...valid, eventKey: "unrecognized-event" }] },
      [{ sourceId: "known", priorReports: [{ eventKey: "previously-reported-event" }] }],
    ),
    [],
  );
  for (const [input, expected] of [[0, 1], [3.5, 4], [4, 4], [9, 5], ["bad", 3]]) {
    const [analysis] = news.parseAnalysis({ stories: [{
      ...valid, importance: input, sentiment: "invalid", tickers: ["$nvda", "NVDA", "UNKNOWN"],
    }] }, candidates);
    assert.equal(analysis.importance, expected);
    assert.equal(analysis.sentiment, "neutral");
    assert.deepEqual(analysis.tickers, ["NVDA"]);
  }
});
