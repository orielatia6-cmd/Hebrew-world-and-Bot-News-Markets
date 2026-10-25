import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const { readPublicArticle, fullArticleLimits, fullArticleContextEnabled } =
  await load("lib/briefing/article-reader.ts", {});

const articleTitle =
  "Nvidia raises guidance after quarterly earnings beat";

function articleHtml(title = articleTitle) {
  const paragraphs = [
    "The company reported stronger demand for its data center products, while management described supply availability as a continuing constraint for customers. Executives said the increase reflects orders from cloud providers and enterprise customers.",
    "The report described the company's latest quarterly performance and the factors behind the change in demand. Management said customers continue to request systems for large computing projects, but delivery timing depends on parts availability.",
    "Executives said the results reflected orders from cloud providers and enterprise customers. The company did not provide a timetable for every customer delivery, and the report did not name each customer or order.",
    "The report also described plans to expand production capacity. Those plans depend on suppliers and the pace at which new equipment can be installed across the company's manufacturing partners.",
    "Analysts will compare future results with the company's guidance and monitor whether customer demand continues at the same pace. The report said that further information will arrive with the next scheduled results.",
  ];
  return `<!doctype html>
    <html><head><title>${title}</title>
      <meta property="og:title" content="${title}">
      <meta property="og:site_name" content="BBC News">
    </head><body>
      <header><nav>World Politics Business Subscribe Sign in</nav></header>
      <div class="advertisement">Advertisement navigation menu</div>
      <main><article><h1>${title}</h1>${paragraphs
        .map((paragraph) => `<p>${paragraph}</p>`)
        .join("")}</article></main>
      <footer>Related stories Newsletter Privacy settings</footer>
    </body></html>`;
}

function allowedRobots() {
  return new Response("User-agent: *\nAllow: /\n", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

test("extracts a matching public article body and removes navigation/advertising", async () => {
  const calls = [];
  const result = await readPublicArticle(
    "https://www.bbc.com/news/business-123",
    articleTitle,
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        calls.push(url.pathname);
        if (url.pathname === "/robots.txt") return allowedRobots();
        return new Response(articleHtml(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  );

  assert.equal(result.status, "article");
  assert.equal(result.title, articleTitle);
  assert.equal(result.siteName, "BBC News");
  assert.match(result.text, /stronger demand for its data center products/u);
  assert.doesNotMatch(result.text, /Advertisement navigation menu|Privacy settings/u);
  assert.deepEqual(calls, ["/robots.txt", "/news/business-123"]);
});

test("blocked HTTP responses are not retried or bypassed", async () => {
  const calls = [];
  const result = await readPublicArticle(
    "https://www.theguardian.com/world/example",
    "Example article title about world events",
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        calls.push(url.pathname);
        if (url.pathname === "/robots.txt") return allowedRobots();
        return new Response("Access denied", {
          status: 403,
          headers: { "content-type": "text/html" },
        });
      },
    },
  );

  assert.equal(result.status, "blocked");
  assert.deepEqual(calls, ["/robots.txt", "/world/example"]);
});

test("a visible subscription wall returns no article text", async () => {
  const result = await readPublicArticle(
    "https://finance.yahoo.com/news/example",
    "Example article title about markets",
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/robots.txt") return allowedRobots();
        return new Response(
          `<!doctype html><html><head><title>Example article title about markets</title></head>
           <body><main><article><h1>Example article title about markets</h1>
           <p>Subscribe to continue reading the full report.</p>
           </article></main><div class="paywall">Subscription required</div></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        );
      },
    },
  );

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /paywall/u);
});

test("robots exclusions and unapproved hosts are respected before article requests", async () => {
  let requests = 0;
  const disallowed = await readPublicArticle(
    "https://www.bbc.co.uk/news/private-story",
    "Private story title with enough matching words",
    {
      fetchImpl: async () => {
        requests += 1;
        return new Response("User-agent: *\nDisallow: /news/\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    },
  );
  assert.equal(disallowed.status, "blocked");
  assert.equal(requests, 1, "robots policy is checked before the article page");

  const unsupported = await readPublicArticle(
    "https://www.reuters.com/world/example",
    "Example article title about world events",
    {
      fetchImpl: async () => {
        requests += 1;
        return new Response("should not be requested");
      },
    },
  );
  assert.equal(unsupported.status, "not-allowed");
  assert.equal(requests, 1);
});

test("unrelated page titles and oversized article bodies fall back instead of being treated as full text", async () => {
  const wrongTitle = await readPublicArticle(
    "https://www.bbc.com/news/world-123",
    articleTitle,
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/robots.txt") return allowedRobots();
        return new Response(articleHtml("Another unrelated headline"), {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    },
  );
  assert.equal(wrongTitle.status, "title-mismatch");

  const tooLarge = await readPublicArticle(
    "https://www.bbc.com/news/world-oversized",
    articleTitle,
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/robots.txt") return allowedRobots();
        return new Response("x".repeat(fullArticleLimits.maxHtmlBytes + 1), {
          status: 200,
          headers: {
            "content-type": "text/html",
            "content-length": String(fullArticleLimits.maxHtmlBytes + 1),
          },
        });
      },
    },
  );
  assert.equal(tooLarge.status, "too-large");
});

test("article retrieval is explicitly opt-in", () => {
  const oldValue = process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
  delete process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
  assert.equal(fullArticleContextEnabled(), false);
  process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED = "true";
  assert.equal(fullArticleContextEnabled(), true);
  if (oldValue === undefined) delete process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED;
  else process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED = oldValue;
});
