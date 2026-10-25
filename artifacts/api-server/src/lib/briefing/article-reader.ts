import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const ALLOWED_PUBLISHER_DOMAINS = [
  "bbc.com",
  "bbc.co.uk",
  "theguardian.com",
  "yahoo.com",
] as const;

const MAX_HTML_BYTES = 512 * 1024;
const MAX_ROBOTS_BYTES = 16 * 1024;
const MAX_ARTICLE_TEXT_CHARS = 8_000;
const MIN_ARTICLE_TEXT_CHARS = 600;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "BrieflineNews/1.0 (+https://replit.com)";

export type ArticleReadResult =
  | {
      status: "article";
      text: string;
      title: string;
      siteName: string | null;
      finalUrl: string;
    }
  | {
      status:
        | "blocked"
        | "unavailable"
        | "not-allowed"
        | "too-large"
        | "too-long"
        | "insufficient"
        | "title-mismatch";
      reason: string;
    };

export type ArticleReaderOptions = {
  fetchImpl?: typeof fetch;
  robotsCache?: Map<string, Promise<boolean>>;
};

type LimitedTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too-large" | "unavailable" };

function allowedPublisherDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (isIP(host) || host === "localhost" || host.endsWith(".local")) return null;
  return (
    ALLOWED_PUBLISHER_DOMAINS.find(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    ) ?? null
  );
}

function parseAllowedUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !allowedPublisherDomain(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; no response body is retained.
  }
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<LimitedTextResult> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelBody(response);
    return { ok: false, reason: "too-large" };
  }

  const reader = response.body?.getReader();
  if (!reader) return { ok: false, reason: "unavailable" };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    reader.releaseLock();
  }

  return {
    ok: true,
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    ),
  };
}

function robotsPathAllowed(robotsText: string, url: URL): boolean {
  type Rule = { allow: boolean; path: string };
  type Group = { agents: string[]; rules: Rule[] };
  const groups: Group[] = [];
  let current: Group = { agents: [], rules: [] };
  let hasRules = false;

  for (const rawLine of robotsText.split(/\r?\n/u)) {
    const line = rawLine.split("#", 1)[0]?.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      if (hasRules) {
        groups.push(current);
        current = { agents: [], rules: [] };
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (
      (directive === "allow" || directive === "disallow") &&
      current.agents.length > 0 &&
      value
    ) {
      current.rules.push({ allow: directive === "allow", path: value });
      hasRules = true;
    }
  }
  if (current.agents.length > 0) groups.push(current);

  const exactGroups = groups.filter((group) =>
    group.agents.some((agent) => agent === "brieflinenews"),
  );
  const matchingGroups =
    exactGroups.length > 0
      ? exactGroups
      : groups.filter((group) => group.agents.includes("*"));
  const rules = matchingGroups.flatMap((group) => group.rules);
  const path = `${url.pathname}${url.search}`;
  let best: Rule | undefined;
  let bestLength = -1;

  for (const rule of rules) {
    const expression = rule.path
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*/gu, ".*")
      .replace(/\$$/u, "$");
    let matches = false;
    try {
      matches = new RegExp(`^${expression}`, "u").test(path);
    } catch {
      continue;
    }
    if (!matches) continue;
    const specificity = rule.path.replace(/[*$]/gu, "").length;
    if (
      specificity > bestLength ||
      (specificity === bestLength && rule.allow && !best?.allow)
    ) {
      best = rule;
      bestLength = specificity;
    }
  }

  return best?.allow ?? true;
}

async function robotsAllows(
  url: URL,
  fetchImpl: typeof fetch,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const key = url.origin;
  const cached = cache.get(key);
  if (cached) return cached;

  const result = (async () => {
    try {
      const robotsUrl = new URL("/robots.txt", url.origin);
      const response = await fetchImpl(robotsUrl, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/plain" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) {
        await cancelBody(response);
        return true;
      }
      if (response.status !== 200) {
        await cancelBody(response);
        return false;
      }
      const body = await readLimitedText(response, MAX_ROBOTS_BYTES);
      return body.ok && robotsPathAllowed(body.text, url);
    } catch {
      return false;
    }
  })();
  cache.set(key, result);
  return result;
}

function cleanArticleText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function headlineTokens(value: string): Set<string> {
  const ignored = new Set([
    "the", "and", "for", "with", "from", "that", "this", "after", "over",
    "into", "says", "said", "what", "why", "how", "about", "אחרי", "על", "של",
    "עם", "לפי", "בין", "אל", "את", "הוא", "היא", "זה", "זו", "מה", "איך",
  ]);
  return new Set(
    (value.toLocaleLowerCase("he").match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => word.length > 1 && !ignored.has(word)),
  );
}

function headlinesMatch(expected: string, extracted: string): boolean {
  const expectedTokens = headlineTokens(expected);
  const extractedTokens = headlineTokens(extracted);
  if (expectedTokens.size < 2 || extractedTokens.size < 2) return false;
  const overlap = [...expectedTokens].filter((word) =>
    extractedTokens.has(word),
  ).length;
  return overlap >= 2 && overlap / expectedTokens.size >= 0.5;
}

function looksBlocked(document: Document, pageText: string): boolean {
  if (
    document.querySelector(
      '[class*="paywall" i], [id*="paywall" i], [data-testid*="paywall" i]',
    )
  ) {
    return true;
  }
  return /subscribe\s+(?:now\s+)?to\s+(?:continue|read)|sign\s+in\s+to\s+(?:read|continue)|subscription\s+required|subscriber[-\s]only|metered\s+paywall|access\s+denied|verify\s+you(?:'|’)re\s+human|captcha/iu.test(
    pageText,
  );
}

export async function readPublicArticle(
  sourceUrl: string,
  expectedTitle: string,
  options: ArticleReaderOptions = {},
): Promise<ArticleReadResult> {
  const initialUrl = parseAllowedUrl(sourceUrl);
  if (!initialUrl) {
    return { status: "not-allowed", reason: "publisher-or-url-not-allowed" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const robotsCache = options.robotsCache ?? new Map<string, Promise<boolean>>();
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const domain = allowedPublisherDomain(currentUrl.hostname);
    if (!domain) {
      return { status: "not-allowed", reason: "redirect-host-not-allowed" };
    }
    if (!(await robotsAllows(currentUrl, fetchImpl, robotsCache))) {
      return { status: "blocked", reason: "robots-policy-or-check-blocked" };
    }

    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { status: "unavailable", reason: "request-failed-or-timed-out" };
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await cancelBody(response);
      if (!location || redirectCount === MAX_REDIRECTS) {
        return { status: "unavailable", reason: "redirect-limit-or-location" };
      }
      let nextUrl: URL | null = null;
      try {
        nextUrl = parseAllowedUrl(new URL(location, currentUrl).toString());
      } catch {
        return { status: "unavailable", reason: "invalid-redirect-location" };
      }
      if (
        !nextUrl ||
        allowedPublisherDomain(nextUrl.hostname) !== domain
      ) {
        return { status: "not-allowed", reason: "redirect-host-not-allowed" };
      }
      currentUrl = nextUrl;
      continue;
    }

    if (response.status !== 200) {
      await cancelBody(response);
      return { status: "blocked", reason: `http-${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(contentType)) {
      await cancelBody(response);
      return { status: "unavailable", reason: "not-html" };
    }

    const html = await readLimitedText(response, MAX_HTML_BYTES);
    if (!html.ok) {
      return { status: html.reason, reason: "html-size-or-body-limit" };
    }

    let dom: JSDOM | undefined;
    try {
      dom = new JSDOM(html.text, {
        url: currentUrl.toString(),
        contentType: "text/html",
      });
      const document = dom.window.document;
      const pageText = document.body?.textContent ?? "";
      if (looksBlocked(document, pageText)) {
        return { status: "blocked", reason: "paywall-or-access-check-detected" };
      }

      const article = new Readability(document, {
        charThreshold: MIN_ARTICLE_TEXT_CHARS,
        keepClasses: false,
      }).parse();
      const text = cleanArticleText(article?.textContent ?? "");
      if (!article || !text) {
        return { status: "insufficient", reason: "article-body-not-extracted" };
      }
      const articleTitle = (article.title ?? "").trim();
      if (!headlinesMatch(expectedTitle, articleTitle)) {
        return { status: "title-mismatch", reason: "page-title-does-not-match-rss" };
      }
      if (text.length > MAX_ARTICLE_TEXT_CHARS) {
        return { status: "too-long", reason: "article-exceeds-text-limit" };
      }
      if (text.length < MIN_ARTICLE_TEXT_CHARS) {
        return { status: "insufficient", reason: "article-body-too-short" };
      }

      return {
        status: "article",
        text,
        title: articleTitle,
        siteName:
          article.siteName?.trim() ||
          document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ||
          null,
        finalUrl: currentUrl.toString(),
      };
    } catch {
      return { status: "unavailable", reason: "html-parse-failed" };
    } finally {
      dom?.window.close();
    }
  }

  return { status: "unavailable", reason: "redirect-limit" };
}

export function fullArticleContextEnabled(): boolean {
  return process.env.BRIEFING_FULL_ARTICLE_CONTEXT_ENABLED === "true";
}

export const fullArticleLimits = {
  maxFetchesPerRun: 1,
  maxHtmlBytes: MAX_HTML_BYTES,
  maxTextChars: MAX_ARTICLE_TEXT_CHARS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
} as const;
