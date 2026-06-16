-- AI for Office — conversation history workbook tag.
--
-- Adds a nullable workbook_name column to ai_sessions so each Excel-client
-- session can be tagged with the workbook it happened in. The per-user history
-- list (GET /client-ai/sessions) shows/filters sessions by this name.
--
-- Nullable on purpose: pre-existing sessions and non-Office sessions have no
-- workbook. RLS on ai_sessions is already governed by the foundation migration
-- (2026-06-12-b) — this is a pure additive column, so no policy changes here.
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS workbook_name VARCHAR(500);
