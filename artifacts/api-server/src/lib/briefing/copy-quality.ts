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
  /^(?:חשוב|הנושא חשוב|האירוע חשוב|הדבר חשוב|המידע חשוב|יש לכך חשיבות|האירוע משמעותי)[.!?…]*$|^(?:ההודעה|הדיווח|האירוע)\s+מספק(?:ת|ים)? למשקיעים מידע(?:\s|[.!?…]|$)/u;
const vagueAnalysis =
  /(?:הרחבת המימון הפעיל בתחום|שינוי חשיפת הסקטור לסיכונים והזדמנויות מימון|חשיפת הסקטור לסיכונים והזדמנויות|הזדמנויות מימון לצד סיכונים|משנה את החשיפה לסיכונים ולהזדמנויות|מייצר הזדמנויות וסיכונים בתחום|(?:חשיפת|חשיפה)\s+.{0,24}סיכונים.{0,24}הזדמנויות)/u;
const genericImpact =
  /^(?:(?:הדבר|ההודעה|ההתפתחות)\s+)?(?:עשוי|עלול|עלולה)?\s*להשפיע על השוק(?:ים)?(?: באופן כללי)?[.!?…]*$|^(?:השפעה|ההשפעה) על השוק אינה ברורה[.!?…]*$/u;
const literalTranslation =
  /(?:כיתה\s+(?:חדשה\s+)?של\s+מניות|class\s+of\s+shares|share\s+class\s+of\s+stock)/iu;

const knownEntityAliases: Array<{ id: string; aliases: string[] }> = [
  { id: "meta", aliases: ["Meta Platforms", "Facebook", "Meta", "מטא"] },
  { id: "sundial", aliases: ["Sundial", "סנדיאל"] },
  { id: "nvidia", aliases: ["Nvidia", "אנבידיה"] },
  { id: "tesla", aliases: ["Tesla", "טסלה"] },
  { id: "google", aliases: ["Google", "Alphabet", "גוגל", "אלפבית"] },
  { id: "microsoft", aliases: ["Microsoft", "מיקרוסופט"] },
  { id: "apple", aliases: ["Apple", "אפל"] },
  { id: "amazon", aliases: ["Amazon", "אמזון"] },
  { id: "openai", aliases: ["OpenAI"] },
  { id: "amd", aliases: ["AMD"] },
  { id: "broadcom", aliases: ["Broadcom"] },
  { id: "trump", aliases: ["Donald Trump", "Trump", "דונלד טראמפ", "טראמפ"] },
  {
    id: "federal-reserve",
    aliases: ["Federal Reserve", "FOMC", "Fed", "הפדרל ריזרב", "הפד"],
  },
  { id: "sp500", aliases: ["S&P 500", "S&P500", "SPX"] },
  { id: "nasdaq", aliases: ["Nasdaq", "NASDAQ", "נאסד״ק", "נאסדק"] },
];

const ignoredProperNouns = new Set([
  "a", "an", "the", "new", "latest", "shares", "stock", "company", "companies",
  "market", "markets", "report", "reports", "says", "said", "announces",
  "announced", "acquire", "acquires", "acquired", "buy", "buys", "bought",
  "purchase", "purchases", "purchased", "agrees", "agreed", "plans", "plan",
  "will", "may", "could", "should", "class", "non", "voting", "quarter",
  "quarterly", "earnings", "revenue", "profit", "profits", "according",
  "reuters", "bloomberg", "cnbc", "wsj", "bbc", "yahoo", "finance",
]);

type EntityAlias = { id: string; alias: string };
type AcquisitionClaim = {
  buyer: string;
  acquired: string;
  polarity: "affirmed" | "negated";
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function entityAliasesForEvidence(sourceTitle: string): EntityAlias[] {
  const aliases: EntityAlias[] = [];
  for (const entity of knownEntityAliases) {
    for (const alias of entity.aliases) {
      aliases.push({ id: entity.id, alias });
    }
  }

  // Company names not in the short common-alias list are taken only from the
  // source headline, never invented from the generated copy.
  const properNouns =
    sourceTitle.match(/\b[A-Z][A-Za-z0-9&.'’-]{2,}\b/gu) ?? [];
  for (const name of properNouns) {
    const normalized = name.toLocaleLowerCase("en-US");
    if (ignoredProperNouns.has(normalized)) continue;
    if (
      aliases.some(
        (entry) =>
          entry.alias.toLocaleLowerCase("en-US") === normalized,
      )
    ) {
      continue;
    }
    aliases.push({ id: `source:${normalized}`, alias: name });
  }
  return aliases.sort((left, right) => right.alias.length - left.alias.length);
}

function entityIdsInText(text: string): Set<string> {
  const ids = new Set<string>();
  for (const entity of knownEntityAliases) {
    if (
      entity.aliases.some((alias) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(alias)}(?![\\p{L}\\p{N}])`,
          "iu",
        ).test(text),
      )
    ) {
      ids.add(entity.id);
    }
  }
  return ids;
}

function entityMentions(
  sentence: string,
  aliases: EntityAlias[],
): Array<{ id: string; start: number; end: number }> {
  const found: Array<{ id: string; start: number; end: number }> = [];
  for (const { id, alias } of aliases) {
    const expression = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(alias).replace(/\\ /gu, "\\s+")}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    for (const match of sentence.matchAll(expression)) {
      const start = match.index;
      if (start === undefined) continue;
      found.push({ id, start, end: start + match[0].length });
    }
  }
  return found
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((mention, index, all) => {
      const previous = all
        .slice(0, index)
        .find(
          (candidate) =>
            candidate.start === mention.start &&
            candidate.end === mention.end &&
            candidate.id === mention.id,
        );
      if (previous) return false;
      return !all
        .slice(0, index)
        .some(
          (candidate) =>
            candidate.start < mention.end && mention.start < candidate.end,
        );
    });
}

const activeAcquisitionVerb =
  /(?:\b(?:acquir(?:e|es|ed|ing)|buy|buys|bought|purchas(?:e|es|ed|ing)|take\s+over|takes\s+over|took\s+over)\b|(?:רוכש(?:ת|ים|ות)?|רכש(?:ה|ו)?|תרכוש|לרכוש|קונ(?:ה|ים|ות)|קנתה|יקנה|רכישת))/iu;
const passiveAcquisitionPhrase =
  /(?:\b(?:acquired|bought|purchased|taken\s+over)\s+by\b|(?:נרכש(?:ה|ו|ת)?|יירכש|תירכש)\s+(?:על\s+ידי|בידי))/iu;
const acquisitionNoun =
  /(?:\bacquisition\s+of\b|\b(?:acquisition|purchase)\s+by\b|רכישת\s+ה?)/iu;
const acquisitionNegation =
  /(?:\b(?:not|never|den(?:y|ies|ied)|ruled\s+out|no\s+plans?\s+to)\b|(?:לא|אין|אינו|אינה|אינם|שלל(?:ה|ו)?|מכחיש(?:ה|ים)?))/iu;
const directionalAcquisitionLanguage =
  /(?:\b(?:acquir(?:e|es|ed|ing)|buy|buys|bought|purchas(?:e|es|ed|ing)|take\s+over|takes\s+over|took\s+over)\b|(?:רוכש(?:ת|ים|ות)?|רכש(?:ה|ו)?|תרכוש|לרכוש|קונ(?:ה|ים|ות)|קנתה|יקנה))/iu;

function claimsFromText(
  text: string,
  aliases: EntityAlias[],
): AcquisitionClaim[] {
  const claims: AcquisitionClaim[] = [];
  const sentences = text.split(/(?<=[.!?…])\s+/u);
  for (const sentence of sentences) {
    const mentions = entityMentions(sentence, aliases);
    for (let leftIndex = 0; leftIndex < mentions.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < mentions.length;
        rightIndex += 1
      ) {
        const left = mentions[leftIndex];
        const right = mentions[rightIndex];
        if (!left || !right || left.id === right.id) continue;
        const between = sentence.slice(left.end, right.start);
        const prefix = sentence.slice(0, left.start);
        let buyer: string | null = null;
        let acquired: string | null = null;

        if (passiveAcquisitionPhrase.test(between)) {
          buyer = right.id;
          acquired = left.id;
        } else if (
          acquisitionNoun.test(between) ||
          (/\bby\b|על\s+ידי|בידי/iu.test(between) &&
            acquisitionNoun.test(prefix))
        ) {
          buyer = right.id;
          acquired = left.id;
        } else if (activeAcquisitionVerb.test(between)) {
          buyer = left.id;
          acquired = right.id;
        }
        if (!buyer || !acquired) continue;

        const relationText = `${between} ${prefix.slice(-35)}`;
        claims.push({
          buyer,
          acquired,
          polarity: acquisitionNegation.test(relationText)
            ? "negated"
            : "affirmed",
        });
      }
    }
  }
  return claims;
}

function contradictoryClaims(claims: AcquisitionClaim[]): boolean {
  const polarityByPair = new Map<string, Set<string>>();
  for (const claim of claims) {
    const pair = [claim.buyer, claim.acquired].sort().join("|");
    const polarities = polarityByPair.get(pair) ?? new Set<string>();
    polarities.add(
      claim.polarity === "affirmed"
        ? `${claim.buyer}>${claim.acquired}`
        : `not:${claim.buyer}>${claim.acquired}`,
    );
    polarityByPair.set(pair, polarities);
  }
  for (const [pair, polarities] of polarityByPair) {
    const [first, second] = pair.split("|");
    const hasOppositeDirection =
      Boolean(first && second) &&
      (polarities.has(`${first}>${second}`) &&
        polarities.has(`${second}>${first}`));
    const hasOppositePolarity = [...polarities].some((entry) =>
      entry.startsWith("not:"),
    ) && [...polarities].some((entry) => !entry.startsWith("not:"));
    if (hasOppositeDirection || hasOppositePolarity) return true;
  }
  return false;
}

/**
 * Conservatively reject explicit company-takeover claims that the source
 * reverses, contradicts, or does not substantiate. This is a deterministic
 * guard; ambiguous cases are omitted rather than guessed.
 */
export function sourceSupportsGeneratedCopy(input: {
  sourceTitle: string;
  sourceText: string;
  generatedText: string;
}): boolean {
  const sourceEntities = entityIdsInText(
    `${input.sourceTitle}\n${input.sourceText}`,
  );
  const generatedEntities = entityIdsInText(input.generatedText);
  if ([...generatedEntities].some((entity) => !sourceEntities.has(entity))) {
    return false;
  }

  const aliases = entityAliasesForEvidence(input.sourceTitle);
  const titleClaims = claimsFromText(input.sourceTitle, aliases);
  const bodyClaims = claimsFromText(input.sourceText, aliases);
  const sourceClaims = [...titleClaims, ...bodyClaims];
  if (contradictoryClaims(sourceClaims)) return false;

  const generatedClaims = claimsFromText(input.generatedText, aliases);
  if (contradictoryClaims(generatedClaims)) return false;
  if (
    directionalAcquisitionLanguage.test(input.generatedText) &&
    generatedClaims.length === 0
  ) {
    return false;
  }
  return generatedClaims.every((generated) =>
    sourceClaims.some(
      (source) =>
        source.buyer === generated.buyer &&
        source.acquired === generated.acquired &&
        source.polarity === generated.polarity,
    ),
  );
}

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
    vagueAnalysis.test(whyItMatters) ||
    ![title, ...summarySentences, whyItMatters].every(containsHebrew) ||
    literalTranslation.test(primaryText) ||
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
      literalTranslation.test(marketImpact) ||
      isEditorialMeta(marketImpact, input.sourceName) ||
      genericImpact.test(marketImpact) ||
      vagueAnalysis.test(marketImpact) ||
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
