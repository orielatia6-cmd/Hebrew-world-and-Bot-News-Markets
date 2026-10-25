import { getEncoding } from "js-tiktoken";

// gpt-5-mini uses the o200k tokenizer family. Keep this explicit so the cap
// does not depend on model-name aliases supported by a package release.
const tokenizer = getEncoding("o200k_base");

export const ANALYSIS_INPUT_TOKEN_LIMIT = 8_192;
const CHAT_MESSAGE_OVERHEAD_TOKENS = 8;
const REQUEST_SAFETY_MARGIN_TOKENS = 512;
const MIN_EXCERPT_TOKENS = 80;

export type AnalysisPayloadStory = {
  sourceId: string;
  title: string;
  source: string;
  materialScope: string;
  excerpt: string;
  previouslyReported?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type FittedAnalysisPayload<T extends AnalysisPayloadStory> = {
  stories: T[];
  truncatedSourceIds: string[];
  droppedSourceIds: string[];
  inputTokenCount: number;
};

export function countEncodedTokens(text: string): number {
  return tokenizer.encode(text).length;
}

export function countChatInputTokens(messages: Array<{ content: string }>): number {
  const contentTokens = messages.reduce(
    (total, message) => total + countEncodedTokens(message.content),
    0,
  );
  return contentTokens + messages.length * CHAT_MESSAGE_OVERHEAD_TOKENS +
    REQUEST_SAFETY_MARGIN_TOKENS;
}

function estimateRequestTokens(systemContents: string[], userContent: string): number {
  return countChatInputTokens([
    ...systemContents.map((content) => ({ content })),
    { content: userContent },
  ]);
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return "";
  if (countEncodedTokens(text) <= maxTokens) return text;

  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countEncodedTokens(characters.slice(0, middle).join("")) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("");
}

function markPartial(story: AnalysisPayloadStory): void {
  if (/article body|article text/i.test(story.materialScope)) {
    story.materialScope =
      "Partial article-body excerpt selected to fit the fixed token budget; not the full article.";
  } else {
    story.materialScope =
      "RSS title and excerpt only; excerpt shortened to fit the fixed token budget; the full article was not fetched.";
  }
}

export function fitAnalysisPayload<T extends AnalysisPayloadStory>(
  input: T[],
  systemContents: string[],
  tokenLimit = ANALYSIS_INPUT_TOKEN_LIMIT,
): FittedAnalysisPayload<T> {
  const stories = input.map((story) => ({
    ...story,
    previouslyReported: story.previouslyReported
      ? [...story.previouslyReported]
      : [],
  })) as T[];
  const truncatedSourceIds = new Set<string>();
  const droppedSourceIds: string[] = [];

  const serialize = () => JSON.stringify(stories);
  let userContent = serialize();
  let inputTokenCount = estimateRequestTokens(systemContents, userContent);

  while (inputTokenCount > tokenLimit && stories.length > 0) {
    const reducible = stories
      .map((story, index) => ({
        story,
        index,
        excerptTokens: countEncodedTokens(story.excerpt),
        articleBody: /article body|article text/i.test(story.materialScope),
      }))
      .filter((entry) => entry.excerptTokens > MIN_EXCERPT_TOKENS)
      .sort((left, right) =>
        Number(right.articleBody) - Number(left.articleBody) ||
        right.excerptTokens - left.excerptTokens ||
        right.index - left.index,
      )[0];

    if (reducible) {
      const overage = inputTokenCount - tokenLimit;
      const reduction = Math.max(64, overage + 24);
      const nextLimit = Math.max(
        MIN_EXCERPT_TOKENS,
        reducible.excerptTokens - reduction,
      );
      const shortened = truncateToTokens(reducible.story.excerpt, nextLimit);
      if (shortened === reducible.story.excerpt) {
        reducible.story.excerpt = truncateToTokens(
          reducible.story.excerpt,
          reducible.excerptTokens - 1,
        );
      } else {
        reducible.story.excerpt = shortened;
      }
      markPartial(reducible.story);
      truncatedSourceIds.add(reducible.story.sourceId);
    } else {
      let historyIndex = -1;
      for (let index = stories.length - 1; index >= 0; index -= 1) {
        if ((stories[index]?.previouslyReported?.length ?? 0) > 0) {
          historyIndex = index;
          break;
        }
      }
      if (historyIndex >= 0) {
        const story = stories[historyIndex];
        story?.previouslyReported?.pop();
      } else {
        const removed = stories.pop();
        if (removed) droppedSourceIds.push(removed.sourceId);
      }
    }

    userContent = serialize();
    inputTokenCount = estimateRequestTokens(systemContents, userContent);
  }

  return {
    stories,
    truncatedSourceIds: [...truncatedSourceIds],
    droppedSourceIds,
    inputTokenCount,
  };
}
