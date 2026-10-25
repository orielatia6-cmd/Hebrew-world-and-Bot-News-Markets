export const requiredBriefingColumns = {
  briefing_settings: [
    "id",
    "enabled",
    "delivery_interval_minutes",
    "min_importance",
    "telegram_chat_id",
    "bot_username",
    "last_telegram_update_id",
    "login_code_hash",
    "login_code_expires_at",
    "last_checked_at",
    "last_sent_at",
    "last_processed_digest_slot_at",
    "last_error",
    "updated_at",
  ],
  briefing_feed_health: [
    "id",
    "name",
    "category",
    "last_attempt_at",
    "last_successful_fetch",
    "last_error",
    "recent_story_count",
  ],
  briefing_stories: [
    "id",
    "source_id",
    "revision_key",
    "event_key",
    "original_title",
    "title",
    "url",
    "source_name",
    "published_at",
    "summary",
    "why_it_matters",
    "market_impact",
    "category",
    "importance",
    "sentiment",
    "tickers",
    "delivered_at",
    "created_at",
  ],
} as const;

export const requiredBriefingIndexes = [
  "briefing_stories_source_revision_unique",
  "briefing_stories_event_revision_unique",
] as const;

type SchemaQueryResult = {
  rows: Array<Record<string, unknown>>;
};

export type SchemaQuery = (
  sql: string,
  values: readonly unknown[],
) => Promise<SchemaQueryResult>;

export type BriefingSchemaInspection = {
  missingColumns: string[];
  missingIndexes: string[];
};

export async function inspectBriefingSchema(
  query: SchemaQuery,
): Promise<BriefingSchemaInspection> {
  const tables = Object.keys(requiredBriefingColumns);
  const columnResult = await query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [tables],
  );
  const columns = new Set(
    columnResult.rows.map(
      (row) => `${String(row.table_name)}.${String(row.column_name)}`,
    ),
  );
  const missingColumns = tables.flatMap((table) =>
    requiredBriefingColumns[table as keyof typeof requiredBriefingColumns]
      .filter((column) => !columns.has(`${table}.${column}`))
      .map((column) => `${table}.${column}`),
  );

  const indexResult = await query(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'briefing_stories'
        AND indexname = ANY($1::text[])`,
    [[...requiredBriefingIndexes]],
  );
  const indexes = new Set(indexResult.rows.map((row) => String(row.indexname)));

  return {
    missingColumns,
    missingIndexes: requiredBriefingIndexes.filter(
      (index) => !indexes.has(index),
    ),
  };
}

export function safeErrorSummary(error: unknown): string {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current && !chain.includes(current); depth += 1) {
    chain.push(current);
    current =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  const names = new Set([
    "AbortError",
    "AggregateError",
    "APIError",
    "AuthenticationError",
    "ConnectionError",
    "DatabaseError",
    "Error",
    "FetchError",
    "NeonDbError",
    "OpenAIError",
    "PostgresError",
    "RateLimitError",
    "TimeoutError",
    "TypeError",
  ]);
  let type = "Error";
  let code: string | undefined;
  let status: number | undefined;
  let missingObject: string | undefined;

  for (const item of chain) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as {
      name?: unknown;
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
    };

    if (type === "Error" && typeof value.name === "string" && names.has(value.name)) {
      type = value.name;
    }
    if (!code && typeof value.code === "string" && /^[A-Z0-9_]{2,32}$/i.test(value.code)) {
      code = value.code.toUpperCase();
    }
    const candidateStatus = value.status ?? value.statusCode;
    if (
      status === undefined &&
      typeof candidateStatus === "number" &&
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 100 &&
      candidateStatus <= 599
    ) {
      status = candidateStatus;
    }
    if (!missingObject && typeof value.message === "string") {
      missingObject = safeMissingDatabaseObject(value.message);
    }
  }

  return [
    `type=${type}`,
    code ? `code=${code}` : undefined,
    status !== undefined ? `status=${status}` : undefined,
    missingObject ? `missing=${missingObject}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function safeMissingDatabaseObject(message: string): string | undefined {
  const allowedTables = Object.keys(requiredBriefingColumns);
  const columnMatch = message.match(
    /column ["']?([a-z_][a-z0-9_]*)["']? of relation ["']?([a-z_][a-z0-9_]*)["']? does not exist/i,
  );
  if (columnMatch) {
    const [, column, table] = columnMatch;
    if (
      allowedTables.includes(table) &&
      requiredBriefingColumns[table as keyof typeof requiredBriefingColumns].includes(
        column as never,
      )
    ) {
      return `${table}.${column}`;
    }
  }

  const unqualifiedColumnMatch = message.match(
    /column ["']?([a-z_][a-z0-9_]*)["']? does not exist/i,
  );
  if (unqualifiedColumnMatch) {
    const [, column] = unqualifiedColumnMatch;
    const owners = allowedTables.filter((table) =>
      requiredBriefingColumns[table as keyof typeof requiredBriefingColumns].includes(
        column as never,
      ),
    );
    if (owners.length === 1) return `${owners[0]}.${column}`;
  }

  const relationMatch = message.match(
    /relation ["']?([a-z_][a-z0-9_]*)["']? does not exist/i,
  );
  if (relationMatch && allowedTables.includes(relationMatch[1])) {
    return `table:${relationMatch[1]}`;
  }
  return undefined;
}
