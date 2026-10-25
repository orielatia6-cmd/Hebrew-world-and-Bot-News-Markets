import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const { ANALYSIS_INPUT_TOKEN_LIMIT, countEncodedTokens, fitAnalysisPayload } =
  await load("lib/briefing/prompt-budget.ts", {});

test("article text is shortened and explicitly labeled partial under the fixed token cap", () => {
  const fullArticle = "Verified reporting about semiconductor demand and supplier capacity. ".repeat(900);
  const result = fitAnalysisPayload(
    [{
      sourceId: "article-1",
      title: "Semiconductor makers report changing demand",
      source: "BBC World",
      materialScope: "Full article body extracted; concise paraphrase only.",
      excerpt: fullArticle,
      previouslyReported: [],
    }],
    ["editorial rules ".repeat(40), "format rules ".repeat(20)],
    1_500,
  );

  assert.equal(result.stories.length, 1);
  assert.ok(result.inputTokenCount <= 1_500);
  assert.deepEqual(result.truncatedSourceIds, ["article-1"]);
  assert.match(result.stories[0].materialScope, /Partial article-body excerpt/u);
  assert.ok(result.stories[0].excerpt.length < fullArticle.length);
  assert.ok(countEncodedTokens(result.stories[0].excerpt) > 0);
});

test("the production request budget is fixed and story selection cannot exceed it", () => {
  const result = fitAnalysisPayload(
    Array.from({ length: 18 }, (_, index) => ({
      sourceId: `rss-${index}`,
      title: `Story ${index} headline about global markets`,
      source: "RSS",
      materialScope: "RSS title and excerpt only; the full article was not fetched",
      excerpt: "Verified RSS facts about the reported event and affected companies. ".repeat(70),
      previouslyReported: [],
    })),
    ["editorial rules ".repeat(120), "ranking rules ".repeat(70)],
  );

  assert.ok(result.stories.length > 0);
  assert.ok(result.inputTokenCount <= ANALYSIS_INPUT_TOKEN_LIMIT);
  assert.ok(
    result.stories.every((story) =>
      story.materialScope.includes("RSS") ||
      story.materialScope.includes("shortened"),
    ),
  );
});
