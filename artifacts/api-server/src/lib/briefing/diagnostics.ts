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

export const migrationTargetColumns = {
  briefing_settings: ["last_processed_digest_slot_at"],
  briefing_stories: ["revision_key", "event_key", "original_title"],
} as const;

export const legacySourceIndex = "briefing_stories_source_id_unique";

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

export type MigrationPreflight = {
  missingTables: string[];
  presentTargetColumns: string[];
  presentTargetIndexes: string[];
  invalidTargetIndexes: string[];
  conflictingIndexLocations: string[];
  legacySourceUniqueIndexPresent: boolean;
  legacySourceIndexOwnedByConstraint: boolean;
  hasDuplicateSourceIds: boolean | null;
  invalidLegacyValues: number | null;
  storiesToBackfill: number | null;
  decision: "ready" | "already-applied" | "blocked";
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
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'briefing_stories'
        AND indexname = ANY($1::text[])`,
    [[...requiredBriefingIndexes]],
  );
  const indexes = new Set(
    indexResult.rows
      .filter((row) => /^CREATE UNIQUE INDEX/i.test(String(row.indexdef)))
      .map((row) => String(row.indexname)),
  );

  return {
    missingColumns,
    missingIndexes: requiredBriefingIndexes.filter(
      (index) => !indexes.has(index),
    ),
  };
}

export async function inspectMigrationPreflight(
  query: SchemaQuery,
): Promise<MigrationPreflight> {
  const targetTables = Object.keys(migrationTargetColumns);
  const tableResult = await query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [targetTables],
  );
  const tables = new Set(tableResult.rows.map((row) => String(row.table_name)));
  const missingTables = targetTables.filter((table) => !tables.has(table));
  if (missingTables.length) {
    return {
      missingTables,
      presentTargetColumns: [],
      presentTargetIndexes: [],
      invalidTargetIndexes: [],
      conflictingIndexLocations: [],
      legacySourceUniqueIndexPresent: false,
      legacySourceIndexOwnedByConstraint: false,
      hasDuplicateSourceIds: null,
      invalidLegacyValues: null,
      storiesToBackfill: null,
      decision: "blocked",
    };
  }

  const columnResult = await query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
        AND column_name = ANY($2::text[])`,
    [
      targetTables,
      Object.values(migrationTargetColumns).flatMap((columns) => [...columns]),
    ],
  );
  const presentColumns = new Set(
    columnResult.rows.map(
      (row) => `${String(row.table_name)}.${String(row.column_name)}`,
    ),
  );
  const allTargetColumns = targetTables.flatMap((table) =>
    migrationTargetColumns[table as keyof typeof migrationTargetColumns].map(
      (column) => `${table}.${column}`,
    ),
  );
  const presentTargetColumns = allTargetColumns.filter((column) =>
    presentColumns.has(column),
  );

  const indexNames = [legacySourceIndex, ...requiredBriefingIndexes];
  const indexResult = await query(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY($1::text[])`,
    [[...indexNames]],
  );
  const presentTargetIndexes = requiredBriefingIndexes.filter((index) =>
    indexResult.rows.some(
      (row) =>
        String(row.indexname) === index &&
        String(row.tablename) === "briefing_stories" &&
        /^CREATE UNIQUE INDEX/i.test(String(row.indexdef)),
    ),
  );
  const invalidTargetIndexes = requiredBriefingIndexes.filter((index) =>
    indexResult.rows.some(
      (row) =>
        String(row.indexname) === index &&
        String(row.tablename) === "briefing_stories" &&
        !/^CREATE UNIQUE INDEX/i.test(String(row.indexdef)),
    ),
  );
  const conflictingIndexLocations = indexResult.rows
    .filter(
      (row) =>
        requiredBriefingIndexes.includes(
          String(row.indexname) as (typeof requiredBriefingIndexes)[number],
        ) &&
        String(row.tablename) !== "briefing_stories",
    )
    .map((row) => `${String(row.indexname)} on ${String(row.tablename)}`);
  const legacySourceUniqueIndexPresent = indexResult.rows.some(
    (row) =>
      String(row.indexname) === legacySourceIndex &&
      String(row.tablename) === "briefing_stories" &&
      /^CREATE UNIQUE INDEX/i.test(String(row.indexdef)),
  );
  const constraintResult = await query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint AS constraints
         JOIN pg_class AS index_class
           ON index_class.oid = constraints.conindid
         JOIN pg_namespace AS schema
           ON schema.oid = index_class.relnamespace
        WHERE schema.nspname = current_schema()
          AND index_class.relname = $1
          AND constraints.contype IN ('p', 'u')
     ) AS index_owned_by_constraint`,
    [legacySourceIndex],
  );
  const legacySourceIndexOwnedByConstraint = Boolean(
    constraintResult.rows[0]?.index_owned_by_constraint,
  );

  const rowResult = await query(
    `SELECT COUNT(*)::bigint AS stories_to_backfill,
            COUNT(*) FILTER (
              WHERE source_id IS NULL OR title IS NULL
            )::bigint AS invalid_legacy_values,
            EXISTS (
              SELECT 1
                FROM briefing_stories
               GROUP BY source_id
              HAVING COUNT(*) > 1
               LIMIT 1
            ) AS has_duplicate_source_ids
       FROM briefing_stories`,
    [],
  );
  const row = rowResult.rows[0] ?? {};
  const storiesToBackfill =
    typeof row.stories_to_backfill === "number"
      ? row.stories_to_backfill
      : Number(row.stories_to_backfill);
  const hasDuplicateSourceIds = Boolean(row.has_duplicate_source_ids);
  const invalidLegacyValues = Number(row.invalid_legacy_values);
  const alreadyApplied =
    presentTargetColumns.length === allTargetColumns.length &&
    presentTargetIndexes.length === requiredBriefingIndexes.length &&
    conflictingIndexLocations.length === 0;
  const readyToApply =
    presentTargetColumns.length === 0 &&
    presentTargetIndexes.length === 0 &&
    invalidTargetIndexes.length === 0 &&
    conflictingIndexLocations.length === 0 &&
    !legacySourceIndexOwnedByConstraint &&
    !hasDuplicateSourceIds &&
    invalidLegacyValues === 0;

  return {
    missingTables,
    presentTargetColumns,
    presentTargetIndexes,
    invalidTargetIndexes,
    conflictingIndexLocations,
    legacySourceUniqueIndexPresent,
    legacySourceIndexOwnedByConstraint,
    hasDuplicateSourceIds: hasDuplicateSourceIds,
    invalidLegacyValues: Number.isFinite(invalidLegacyValues)
      ? invalidLegacyValues
      : null,
    storiesToBackfill: Number.isFinite(storiesToBackfill)
      ? storiesToBackfill
      : null,
    decision: alreadyApplied ? "already-applied" : readyToApply ? "ready" : "blocked",
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
