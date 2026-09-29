-- AI Suggested Fixes W1: where a suggestion came from, plus the manual-steps
-- target type the Done action records outcomes for (W2 produces those rows).
-- Existing rows are keyword-matcher output -> 'catalog_match' via the column
-- DEFAULT (DDL, not a row write). Idempotent; no inner BEGIN/COMMIT.

ALTER TABLE remediation_suggestions
  ADD COLUMN IF NOT EXISTS origin varchar(20) NOT NULL DEFAULT 'catalog_match';

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_origin_check;
ALTER TABLE remediation_suggestions
  ADD CONSTRAINT remediation_suggestions_origin_check CHECK (origin IN ('catalog_match', 'memory', 'ai_research'));

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_target_type_check;
ALTER TABLE remediation_suggestions
  ADD CONSTRAINT remediation_suggestions_target_type_check CHECK (target_type IN ('script', 'script_template', 'playbook', 'diagnostic', 'manual_steps'));

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_target_check;
ALTER TABLE remediation_suggestions
  ADD CONSTRAINT remediation_suggestions_target_check CHECK (
    (target_type = 'script' AND script_id IS NOT NULL)
    OR (target_type = 'script_template' AND script_template_id IS NOT NULL)
    OR (target_type = 'playbook' AND playbook_id IS NOT NULL)
    OR (target_type = 'diagnostic')
    OR (target_type = 'manual_steps')
  );

CREATE INDEX IF NOT EXISTS remediation_suggestions_origin_idx
  ON remediation_suggestions (org_id, origin) WHERE origin <> 'catalog_match';
