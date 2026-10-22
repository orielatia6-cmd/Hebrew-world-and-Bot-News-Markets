-- Additive Briefline quality/deduplication migration.
-- Apply only after reviewing the change; it preserves existing rows.
ALTER TABLE briefing_settings
  ADD COLUMN last_processed_digest_slot_at timestamptz;

ALTER TABLE briefing_stories
  ADD COLUMN revision_key text,
  ADD COLUMN event_key text,
  ADD COLUMN original_title text;

-- Existing items remain individually identifiable and can be matched as
-- legacy event context during a later analysis.
UPDATE briefing_stories
SET revision_key = source_id,
    event_key = 'legacy:' || source_id,
    original_title = title
WHERE revision_key IS NULL
   OR event_key IS NULL
   OR original_title IS NULL;

ALTER TABLE briefing_stories
  ALTER COLUMN revision_key SET NOT NULL,
  ALTER COLUMN event_key SET NOT NULL,
  ALTER COLUMN original_title SET NOT NULL;

DROP INDEX IF EXISTS briefing_stories_source_id_unique;

CREATE UNIQUE INDEX briefing_stories_source_revision_unique
  ON briefing_stories (source_id, revision_key);

CREATE UNIQUE INDEX briefing_stories_event_revision_unique
  ON briefing_stories (event_key, revision_key);
