-- AI Suggested Fixes W2: the `research` agent kind and `remediation_research`
-- run profile, plus honest system attribution for the auto-provisioned
-- partner baseline research agent (spec open item 1).
--
-- ai_agents.created_by was NOT NULL REFERENCES users(id). No system user row
-- exists and a fake one would be a non-person identity in every user list, so
-- the column becomes nullable and a row must name EITHER a real user OR a
-- named system provisioner — never both (XOR). Existing rows all have
-- created_by set and no provisioned_by, so the CHECK validates immediately.
--
-- Provenance must not be forgeable: ai_agents_isolation lets any
-- tenant-authorized breeze_app context INSERT/UPDATE its own rows, so a
-- trigger refuses, outside the system scope, (a) inserting a row with
-- provisioned_by set and (b) changing created_by or provisioned_by at all.
-- Authorized edits that leave both untouched are unaffected.
-- Idempotent; DDL only; no inner BEGIN/COMMIT.

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_kind_chk;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_kind_chk
  CHECK (kind IN ('triage', 'patch', 'helpdesk', 'designer', 'research'));

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design', 'patch', 'analysis', 'remediation_research'));

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS provisioned_by varchar(64);
ALTER TABLE ai_agents ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_creator_chk;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_creator_chk
  CHECK ((created_by IS NULL) <> (provisioned_by IS NULL));

CREATE OR REPLACE FUNCTION public.ai_agents_provenance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF public.breeze_current_scope() = 'system' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.provisioned_by IS NOT NULL THEN
      RAISE EXCEPTION 'ai_agents.provisioned_by can only be set in the system scope'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.provisioned_by IS DISTINCT FROM OLD.provisioned_by THEN
    RAISE EXCEPTION 'ai_agents provenance (created_by, provisioned_by) can only change in the system scope'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ai_agents_provenance_guard ON ai_agents;
CREATE TRIGGER ai_agents_provenance_guard
  BEFORE INSERT OR UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION public.ai_agents_provenance_guard();

COMMENT ON COLUMN ai_agents.provisioned_by IS
  'Named system provisioner (e.g. system:remediation_research) for rows no human created. Exactly the rows with created_by NULL set it (ai_agents_creator_chk, XOR); only the system scope may write it (ai_agents_provenance_guard).';
