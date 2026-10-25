import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, load } from "./harness.mjs";

const { ANALYSIS_INPUT_TOKEN_LIMIT, countChatInputTokens } =
  await load("lib/briefing/prompt-budget.ts", {});

function professionalStory(sourceId, overrides = {}) {
  return {
    sourceId,
    title: "הבנק המרכזי פרסם החלטת מדיניות חדשה",
    summary: "הבנק המרכזי פרסם החלטת מדיניות חדשה. המסמך מפרט את מועד התחולה ואת סעיפי ההחלטה.",
    whyItMatters: "ההחלטה עשויה לשנות את עלות המימון של משקי הבית והעסקים.",
    marketImpact: "אם התנאים שונים מציפיות השוק, מדדי האג״ח עשויים להגיב.",
    importance: 3,
    tickers: [],
    sentiment: "neutral",
    eventKey: "",
    materialUpdate: false,
    ...overrides,
  };
}

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
        { title: "News", link: "https://example.test/news#one", isoDate: new Date().toISOString(), source: "Reuters", contentSnippet: "The company raised its annual outlook after revenue growth and stronger demand across several business lines." },
        { title: "News again", link: "https://example.test/news#two", isoDate: new Date().toISOString(), source: "Reuters", contentSnippet: "The company raised its annual outlook after revenue growth and stronger demand across several business lines." },
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
          stories: candidates.map((c) => professionalStory(c.sourceId)),
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
  assert.equal(f.stories[0].sourceName, "Reuters · תקציר RSS בלבד");
  assert.equal(f.stories[0].importance, 3, "below-threshold stories remain available for later settings changes");
  assert.equal((await news.refreshNews()).newStories, 0);
  assert.equal(requests.length, 1, "seen stories must not incur another analysis call");
});

test("article-body context remains off by default and labels new summaries as RSS-only", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousArticleFlag = process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
  process.env.OPENAI_API_KEY = "fake-test-key";
  delete process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousArticleFlag === undefined) delete process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
    else process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED = previousArticleFlag;
  });

  let articleReads = 0;
  let aiCalls = 0;
  let requestItems = [];
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    text: async () => "fixture feed",
  }));
  f.mocks["article-reader"] = {
    readPublicArticle: async () => {
      articleReads += 1;
      return { status: "article", text: "Unrequested article body", title: "A story", siteName: "BBC News", finalUrl: "https://www.bbc.com/news/story" };
    },
    fullArticleLimits: { maxFetchesPerRun: 1 },
  };
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class {
      async parseString() {
        return { items: [{
          title: "Company announces a production expansion",
          link: "https://example.test/production-expansion",
          isoDate: new Date().toISOString(),
          source: "Reuters",
          contentSnippet: "The company announced a production expansion after reporting stronger customer demand and describing how suppliers will support the additional manufacturing capacity.",
        }] };
      }
    } },
    openai: { default: class {
      chat = { completions: { create: async (request) => {
        aiCalls += 1;
        requestItems = JSON.parse(request.messages.find((message) => message.role === "user").content);
        return { choices: [{ message: { content: JSON.stringify({
          stories: requestItems.map((item) => professionalStory(item.sourceId)),
        }) } }] };
      } } };
    } },
  });

  const result = await news.refreshNews();
  assert.equal(result.newStories, 1);
  assert.equal(articleReads, 0, "default-off mode makes no article-page requests");
  assert.equal(aiCalls, 1, "the existing single analysis call remains unchanged");
  assert.equal(requestItems[0].materialScope, "RSS title and excerpt only; the full article was not fetched");
  assert.match(f.stories[0].sourceName, /תקציר RSS בלבד/u);
});

test("opt-in article context is capped, paraphrase-only, and falls back to RSS for remaining stories", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousArticleFlag = process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
  process.env.OPENAI_API_KEY = "fake-test-key";
  process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED = "true";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousArticleFlag === undefined) delete process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
    else process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED = previousArticleFlag;
  });

  const articleReads = [];
  let aiCalls = 0;
  let requestItems = [];
  let aiRequestMessages = [];
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    text: async () => "fixture feed",
  }));
  f.mocks["article-reader"] = {
    readPublicArticle: async (url, title) => {
      articleReads.push({ url, title });
      return {
        status: "article",
        text: `FULL ARTICLE BODY: ${title}. ${"Verified article detail with context and reporting. ".repeat(20)}`,
        title,
        siteName: "BBC News",
        finalUrl: url,
      };
    },
    fullArticleLimits: { maxFetchesPerRun: 1 },
  };
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class {
      async parseString() {
        return { items: [1, 2, 3].map((number) => ({
          title: `Company announces production expansion ${number}`,
          link: `https://example.test/production-expansion-${number}`,
          isoDate: new Date().toISOString(),
          source: "Reuters",
          contentSnippet: `The company announced production expansion ${number} after reporting stronger customer demand and describing how suppliers will support the additional manufacturing capacity.`,
        })) };
      }
    } },
    openai: { default: class {
      chat = { completions: { create: async (request) => {
        aiCalls += 1;
        aiRequestMessages = request.messages;
        requestItems = JSON.parse(request.messages.find((message) => message.role === "user").content);
        assert.equal(request.model, "gpt-5-mini");
        assert.equal(request.max_completion_tokens, 8192);
        assert.ok(
          countChatInputTokens(request.messages) <= ANALYSIS_INPUT_TOKEN_LIMIT,
          "the serialized model input remains within the fixed token cap",
        );
        assert.match(request.messages[0].content, /פרפרזה קצרה בלבד/u);
        assert.match(request.messages[0].content, /אל תתרגם או תשחזר את הכתבה כולה/u);
        return { choices: [{ message: { content: JSON.stringify({
          stories: requestItems.map((item) => professionalStory(item.sourceId)),
        }) } }] };
      } } };
    } },
  });

  const result = await news.refreshNews();
  assert.equal(result.newStories, 3);
  assert.equal(articleReads.length, 1, "no more than one candidate page is fetched per refresh");
  assert.equal(aiCalls, 1, "full text uses the existing analysis call");
  assert.ok(aiRequestMessages.length > 0);
  assert.equal(requestItems.filter((item) => item.materialScope.startsWith("Full article")).length, 1);
  assert.equal(requestItems.filter((item) => item.materialScope.startsWith("RSS title")).length, 2);
  assert.ok(requestItems.some((item) => item.excerpt.startsWith("FULL ARTICLE BODY:")));
  assert.equal(f.stories.filter((story) => story.sourceName.includes("תקציר RSS בלבד")).length, 2);
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
       return { items: [{ title: "New story", link: "https://example.test/new-story", isoDate: new Date().toISOString(), contentSnippet: "A company announced a new agreement that will expand production capacity and create a larger supply commitment next year." }] };
    } } },
    openai: { default: class {
      constructor(options) { assert.equal(options.timeout, 90_000); }
      chat = { completions: { create: async () => { throw new Error("Request timed out."); } } };
    } },
  });

  await assert.rejects(news.refreshNews(), /OpenAI news analysis request timed out after 90 seconds/);
  assert.equal(f.stories.length, 0, "an AI failure must not create generic fallback news");
});

test("headline-only stories are skipped and unavailable AI fails closed without fabricated fallback", async (t) => {
  const f = fixture();
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => previousKey === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previousKey);

  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "fixture feed" }));
  const news = await load("lib/briefing/news.ts", {
    ...f.mocks,
    "rss-parser": { default: class { async parseString() {
      return { items: [
        { title: "Headline only", link: "https://example.test/headline", isoDate: new Date().toISOString() },
        {
          title: "Policy update",
          link: "https://example.test/policy",
          isoDate: new Date().toISOString(),
          contentSnippet: "The central bank published a detailed policy update, including implementation dates and changes to its lending terms.",
        },
      ] };
    } } },
  });

  await assert.rejects(news.refreshNews(), /OPENAI_API_KEY is not configured/);
  assert.equal(f.stories.length, 0, "no AI-generated or generic replacement story is persisted");
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
       return { items: [{ title: "News", link: `https://example.test/${encodeURIComponent(feedUrl)}`, isoDate: new Date().toISOString(), contentSnippet: "The central bank published a detailed policy update after its meeting, including a new timetable for implementation." }] };
    } } },
    openai: { default: class {
      chat = { completions: { create: async (request) => {
        const candidates = JSON.parse(request.messages.find((message) => message.role === "user").content);
        return { choices: [{ message: { content: JSON.stringify({
          stories: candidates.map((candidate) => professionalStory(candidate.sourceId, {
            title: "הבנק המרכזי פרסם עדכון מדיניות",
            summary: "הבנק המרכזי פרסם עדכון למדיניות לאחר ישיבתו. המסמך כולל לוח זמנים ליישום.",
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
        { title: "Headline only", link: "https://example.test/headline-only", isoDate: new Date(now - 5 * 60_000).toISOString() },
        { title: "Fresh market news", link: "https://example.test/fresh", isoDate: new Date(now - 5 * 60_000).toISOString(), contentSnippet: "Fresh market news", summary: "The Federal Reserve published a policy update with details about its timetable and implementation process." },
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
  assert.match(analyzedCandidates[0].excerpt, /published a policy update/);
  assert.equal(
    analyzedCandidates[0].materialScope,
    "RSS title and excerpt only; the full article was not fetched",
  );
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
    summary: "הפדרל ריזרב הותיר את הריבית על 5.25%.",
    whyItMatters: "ההחלטה משפיעה על עלות האשראי.",
    marketImpact: "אם ההחלטה שונה מציפיות השוק, התשואות עשויות להשתנות.",
    importance: 4, sentiment: "neutral", tickers: [],
  };
  assert.equal(news.parseAnalysis({ stories: [base] }, [candidate]).length, 1);
  assert.deepEqual(
    news.parseAnalysis({ stories: [{ ...base, summary: "הריבית נקבעה על 6.25%." }] }, [candidate]),
    [],
  );
  assert.deepEqual(
    news.parseAnalysis({ stories: [{ ...base, summary: "הפד אמר ״ההחלטה מפתיעה״. פרטים נוספים מופיעים במקור." }] }, [candidate]),
    [],
  );
});

test("professional Hebrew rejects source insertion and meta language, while keeping distinct market analysis", async () => {
  const f = fixture();
  const news = await load("lib/briefing/news.ts", f.mocks, { "news.ts": ["parseAnalysis"] });
  const candidate = {
    sourceId: "wsj",
    title: "S&P 500 profit growth depends on a handful of stocks, WSJ says",
    articleContext: "A small group of companies accounts for much of earnings growth in the S&P 500.",
    sourceName: "The Wall Street Journal",
    priorReports: [],
  };
  const malformed = {
    sourceId: "wsj",
    title: "שיא הרווחים תלוי בכמה מניות בודדות, לפי WSJ",
    summary: "דיווח הבום ברווחי החברות נשען באופן WSJ כבד על מספר מועט של מניות. הכותרת מצביעה על ריכוזיות בתרומת הרווחים לשוק.",
    whyItMatters: "הכותרת מצביעה על ריכוזיות בתרומת הרווחים לשוק.",
    marketImpact: "המדד תלוי ברווחי אותן חברות.",
    importance: 4,
    sentiment: "neutral",
    tickers: ["SPX"],
  };
  assert.deepEqual(news.parseAnalysis({ stories: [malformed] }, [candidate]), []);

  const polished = {
    ...malformed,
    title: "מספר מצומצם של חברות מוביל את צמיחת הרווחים במדד",
    summary: "חלק ניכר מצמיחת הרווחים במדד מגיע ממספר מצומצם של חברות. הקטע הזמין אינו מפרט את שמותיהן או את היקף התרומה.",
    whyItMatters: "הנתון מלמד שהצמיחה ברווחי המדד אינה מתפזרת באופן שווה בין החברות.",
    marketImpact: "אם החברות המובילות יאכזבו, תחזיות הרווח של המדד עלולות להיחלש.",
  };
  const parsed = news.parseAnalysis({ stories: [polished] }, [candidate]);
  assert.equal(parsed.length, 1);
  assert.doesNotMatch(
    `${parsed[0].title} ${parsed[0].summary} ${parsed[0].whyItMatters} ${parsed[0].marketImpact}`,
    /WSJ|Wall Street Journal|הכותרת מצביעה|דיווח הבום/u,
  );
  assert.notEqual(parsed[0].whyItMatters, parsed[0].marketImpact);
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
  const valid = {
    sourceId: "known",
    title: "הבנק פרסם החלטת מדיניות",
    summary: "הבנק המרכזי פרסם את החלטתו לאחר ישיבה. המסמך מפרט את מועד התחולה.",
    whyItMatters: "ההחלטה משנה את עלות האשראי עבור משקי הבית והחברות.",
    marketImpact: "אם ההחלטה שונה מהציפיות, תשואות האג״ח עשויות להשתנות.",
  };
  assert.deepEqual(news.parseAnalysis({ stories: [{ ...valid, sourceId: "unknown" }] }, candidates), []);
  assert.deepEqual(news.parseAnalysis({ stories: [{ ...valid, summary: "English only" }] }, candidates), []);
  assert.equal(
    news.parseAnalysis({ stories: [{ ...valid, marketImpact: "" }] }, candidates).length,
    1,
    "a story without a supported market impact remains valid and may omit that section",
  );
  assert.deepEqual(
    news.parseAnalysis({ stories: [{ ...valid, summary: "הבנק המרכזי פרסם החלטת ריבית חדשה." }] }, candidates).length,
    1,
    "one factual sentence is sufficient when the source provides only one key fact",
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
  const fullerSummary = `${Array.from({ length: 41 }, () => "המסמך מפרט שינוי חשוב במדיניות").join(", ")}. ${Array.from({ length: 40 }, () => "העדכון חל על תנאי המימון במשק").join(", ")}.`;
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
      { stories: [{ ...valid, marketImpact: valid.whyItMatters }] },
      candidates,
    )[0]?.marketImpact,
    "",
    "a repeated impact is omitted without discarding the useful story",
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
