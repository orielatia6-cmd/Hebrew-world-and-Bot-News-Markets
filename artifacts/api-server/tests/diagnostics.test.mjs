import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const diagnostics = await load(
  "lib/briefing/diagnostics.ts",
  {},
  {
    "diagnostics.ts": [
      "inspectBriefingSchema",
      "requiredBriefingColumns",
      "requiredBriefingIndexes",
      "safeErrorSummary",
    ],
  },
);

test("read-only schema inspection checks only required metadata", async () => {
  const calls = [];
  const allColumns = Object.entries(diagnostics.requiredBriefingColumns).flatMap(
    ([table_name, names]) => names.map((column_name) => ({ table_name, column_name })),
  );

  const result = await diagnostics.inspectBriefingSchema(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("information_schema.columns")) return { rows: allColumns };
    if (sql.includes("FROM pg_indexes")) {
      return { rows: diagnostics.requiredBriefingIndexes.map((indexname) => ({ indexname })) };
    }
    throw new Error("Unexpected query");
  });

  assert.deepEqual(result, { missingColumns: [], missingIndexes: [] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /information_schema\.columns/);
  assert.match(calls[1].sql, /FROM pg_indexes/);
  assert.deepEqual(calls[0].values, [Object.keys(diagnostics.requiredBriefingColumns)]);
});

test("schema inspection identifies missing columns and indexes without reading rows", async () => {
  const result = await diagnostics.inspectBriefingSchema(async (sql) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ table_name: "briefing_settings", column_name: "id" }] };
    }
    return { rows: [] };
  });

  assert.ok(result.missingColumns.includes("briefing_stories.revision_key"));
  assert.ok(result.missingColumns.includes("briefing_settings.last_processed_digest_slot_at"));
  assert.deepEqual(result.missingIndexes, [...diagnostics.requiredBriefingIndexes]);
});

test("safe error summary reports allowlisted schema details but never raw messages", () => {
  const error = Object.assign(
    new Error(
      'column "revision_key" of relation "briefing_stories" does not exist; token=do-not-log',
    ),
    { code: "42703" },
  );
  const output = diagnostics.safeErrorSummary(error);

  assert.equal(output, "type=Error code=42703 missing=briefing_stories.revision_key");
  assert.doesNotMatch(output, /do-not-log|token=/);
});

test("safe error summary filters unsafe error names, codes, statuses, and messages", () => {
  const error = Object.assign(
    new Error("postgres://user:password@host/private and Telegram token value"),
    {
      name: "Bearer token value",
      code: "postgres://user:password@host",
      status: 999,
    },
  );
  const output = diagnostics.safeErrorSummary(error);

  assert.equal(output, "type=Error");
  assert.doesNotMatch(output, /password|Telegram|Bearer|host|postgres:\/\//);
});
