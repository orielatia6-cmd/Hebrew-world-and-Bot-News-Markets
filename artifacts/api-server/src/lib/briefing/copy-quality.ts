export type NewsCopyInput = {
  title: string;
  summary: string;
  whyItMatters: string;
  marketImpact?: string | null;
  sourceName?: string | null;
};

export type NewsCopy = {
  title: string;
  summary: string;
  whyItMatters: string;
  marketImpact: string;
};

export type CopyValidationOptions = {
  /** Existing database rows may have longer headlines/summaries than new AI output. */
  legacyStored?: boolean;
};

const publisherNames =
  /\b(?:WSJ|Wall Street Journal|Reuters|Bloomberg|CNBC|Yahoo Finance|BBC(?: News)?|The Guardian|Financial Times|Associated Press|AP News|Google News)\b/iu;
const metaPhrases =
  /(?:הכותרת\s+(?:מצביעה|אומרת|מעידה|מרמזת|מראה)|(?:המקור|הכתבה|הדיווח|הסיכום)\s+(?:מתאר|מצביע|מראה|אומר|מסביר|מדווח|מציין)|מהכותרת\s+עולה|מהדיווח\s+עולה|דיווח\s+הבום|באופן\s+\p{L}+\s+כבד)/iu;
const literalEnglishPhrases =
  /\b(?:according to|the headline|headline indicates|report says|earnings boom|stocks earnings)\b/iu;
const genericWhy =
  /^(?:חשוב|הנושא חשוב|האירוע חשוב|הדבר חשוב|המידע חשוב|יש לכך חשיבות|האירוע משמעותי)[.!?…]*$|^(?:ההודעה|הדיווח|האירוע)\s+מספק(?:ת|ים)? למשקיעים מידע\b/u;
const genericImpact =
  /^(?:(?:הדבר|ההודעה|ההתפתחות)\s+)?(?:עשוי|עלול|עלולה)?\s*להשפיע על השוק(?:ים)?(?: באופן כללי)?[.!?…]*$|^(?:השפעה|ההשפעה) על השוק אינה ברורה[.!?…]*$/u;

const stopWords = new Set([
  "אחרי", "את", "או", "אם", "אין", "אלה", "אשר", "בין", "גם", "היא", "היו",
  "הם", "הן", "הוא", "הזה", "הזו", "זה", "זו", "כך", "כי", "כן", "לא", "לפי",
  "מול", "על", "עם", "של", "שלה", "שלו", "כדי", "יותר", "פחות", "עשוי", "עשויה",
  "עשויים", "עלול", "עלולה", "עלולים", "הדבר", "הנתון",
]);

function clean(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function comparisonText(text: string): string {
  return text.toLocaleLowerCase("he").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/u).map((part) => part.trim()).filter(Boolean);
}

function meaningfulWords(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase("he").match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => word.length > 2 && !stopWords.has(word)),
  );
}

function similarity(left: string, right: string): number {
  const a = meaningfulWords(left);
  const b = meaningfulWords(right);
  if (a.size < 3 || b.size < 3) return 0;
  const overlap = [...a].filter((word) => b.has(word)).length;
  return overlap / new Set([...a, ...b]).size;
}

function containsHebrew(text: string): boolean {
  return /[\u0590-\u05ff]/u.test(text);
}

function sourceNameInBody(text: string, sourceName?: string | null): boolean {
  if (!sourceName) return false;
  const label = sourceName.split(/\s+[·—–-]\s+/u)[0]?.trim();
  if (!label || label.length < 4) return false;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function isEditorialMeta(text: string, sourceName?: string | null): boolean {
  return (
    publisherNames.test(text) ||
    sourceNameInBody(text, sourceName) ||
    metaPhrases.test(text) ||
    literalEnglishPhrases.test(text)
  );
}

function withoutHeadlineEcho(title: string, summary: string): string {
  const titleKey = comparisonText(title);
  return sentences(summary)
    .filter((sentence) => comparisonText(sentence) !== titleKey)
    .join(" ")
    .trim();
}

/**
 * Accept only copy that is safe to publish as professional Hebrew. Market impact
 * is optional and is omitted when it repeats the explanation or adds no detail.
 */
export function normalizeProfessionalCopy(
  input: NewsCopyInput,
  options: CopyValidationOptions = {},
): NewsCopy | null {
  const title = clean(input.title);
  const summary = withoutHeadlineEcho(title, clean(input.summary));
  const whyItMatters = clean(input.whyItMatters);
  let marketImpact = clean(input.marketImpact ?? "");
  const titleWords = title.split(/\s+/u).filter(Boolean);
  const summarySentences = sentences(summary);
  const whySentences = sentences(whyItMatters);
  const impactSentences = sentences(marketImpact);
  const primaryText = `${title}\n${summary}\n${whyItMatters}`;

  if (
    !title ||
    (!options.legacyStored && titleWords.length > 12) ||
    !summary ||
    summarySentences.length < 1 ||
    (!options.legacyStored && summarySentences.length > 2) ||
    whySentences.length !== 1 ||
    whyItMatters.length < 18 ||
    genericWhy.test(whyItMatters) ||
    ![title, ...summarySentences, whyItMatters].every(containsHebrew) ||
    isEditorialMeta(primaryText, input.sourceName) ||
    similarity(summary, whyItMatters) >= 0.72
  ) {
    return null;
  }

  if (
    marketImpact &&
    (
      impactSentences.length !== 1 ||
      !containsHebrew(marketImpact) ||
      isEditorialMeta(marketImpact, input.sourceName) ||
      genericImpact.test(marketImpact) ||
      similarity(whyItMatters, marketImpact) >= 0.56 ||
      similarity(summary, marketImpact) >= 0.72
    )
  ) {
    marketImpact = "";
  }

  return { title, summary, whyItMatters, marketImpact };
}

/**
 * RSS snippets are not full articles. Reject title-only or title-echo material
 * before spending analysis effort or implying that an article was read.
 */
export function hasSubstantiveExcerpt(title: string, excerpt: string): boolean {
  const cleanTitle = comparisonText(title);
  const cleanExcerpt = clean(excerpt);
  if (cleanExcerpt.length < 45 || comparisonText(cleanExcerpt) === cleanTitle) return false;
  const titleWords = meaningfulWords(title);
  const newContextWords = [...meaningfulWords(cleanExcerpt)].filter(
    (word) => !titleWords.has(word),
  );
  return newContextWords.length >= 3;
}
