-- Sorts after the workspace table creation (2026-10-16-180300).
-- Old rows remain NULL: the runtime image cannot be inferred retrospectively.
-- Existing org-scoped forced RLS applies to this column too.
ALTER TABLE ai_run_workspaces ADD COLUMN IF NOT EXISTS runtime_image text;
