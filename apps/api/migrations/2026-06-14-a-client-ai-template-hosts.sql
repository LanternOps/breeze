-- AI for Office — app-target prompt templates.
--
-- Templates are app-specific prompts (a slide-design prompt is noise in Excel),
-- so each template can target a subset of the four hosts. Semantics:
--   hosts IS NULL  → show in ALL hosts (the back-compat default for every
--                    existing row, and the canonical "all hosts" value)
--   hosts = {...}  → show ONLY in the listed hosts
-- The client list endpoint filters `hosts IS NULL OR <host> = ANY(hosts)`.
-- No tenancy implications — this is a display filter, not an access axis — so
-- the table's existing dual-axis RLS is untouched.

ALTER TABLE client_ai_prompt_templates ADD COLUMN IF NOT EXISTS hosts text[];

-- Defense-in-depth: every array element must be a known host (the API also
-- validates via a Zod enum). `<@` = "contained by"; NULL and {} both pass.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_ai_prompt_templates_hosts_check'
  ) THEN
    ALTER TABLE client_ai_prompt_templates
      ADD CONSTRAINT client_ai_prompt_templates_hosts_check
      CHECK (hosts IS NULL OR hosts <@ ARRAY['excel','word','powerpoint','outlook']::text[]);
  END IF;
END $$;
