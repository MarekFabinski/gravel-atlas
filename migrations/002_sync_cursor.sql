-- Persisted forward-scan cursor for /api/sync. The rides watermark
-- (MAX(started_at)) stalls forever once a full page of non-importable
-- Strava activities (runs, Zwift, etc.) inserts nothing — this cursor lets
-- the sync route page past such gaps without re-scanning them every call.
ALTER TABLE strava_tokens ADD COLUMN sync_cursor BIGINT NOT NULL DEFAULT 0;
