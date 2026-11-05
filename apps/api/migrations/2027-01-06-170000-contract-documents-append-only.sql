-- #9075 W4b (spec docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md,
-- Open Decision 2 option B): contract_documents becomes append-only.
--
-- A contract_documents row is a signed agreement: the PDF / uploaded bytes,
-- their hashes and the signer evidence snapshot. W1b moved the evidence onto
-- the row so it survives its quote or request; this migration makes the
-- database, not only the API, refuse to rewrite or delete it.
--
-- WHAT MAY STILL CHANGE (everything else is frozen by the trigger for EVERY
-- role, the table owner included; see THREAT MODEL for what skips triggers):
--
--   contract_id       The filing link, not evidence. linkContractDocument
--                     (NULL -> contract), contractAdoptService (draft ->
--                     adopting contract) and contracts' ON DELETE SET NULL.
--                     The API keeps its own ALREADY_LINKED rule on top.
--   org_id            Only the org-merge re-point (orgMergeRegistry
--                     REPOINT_TABLES): system scope, the old org fenced
--                     'merging', the new org under the same partner. Same
--                     predicate as ai_invocations_append_only
--                     (2026-11-14-100300). A partner caller can flip an org's
--                     status itself, so the fence alone is not enough; the
--                     system-scope check keeps a request-path caller out.
--   quote_id, quote_acceptance_id, agreement_request_id, recorded_by_user_id
--                     Provenance pointers. Each may only be CLEARED, and only
--                     from inside another trigger (pg_trigger_depth() > 1),
--                     which is how its own FK's ON DELETE SET NULL reaches
--                     this table. Deleting a quote, request or user therefore
--                     keeps working (spec §4.4) and the evidence snapshot
--                     stays. Depth only says "inside SOME trigger", so it is
--                     not what stops breeze_app: breeze_app holds UPDATE on
--                     contract_id and org_id ONLY (see PRIVILEGES), so neither
--                     a direct UPDATE nor a pg_temp trigger of its own can
--                     touch these columns. The RI action runs as the table
--                     owner and needs no grant.
--
--   There is no updated_at column. If one is ever added it is frozen like
--   every other column until this function is amended: the guard compares
--   the whole row (NEW IS DISTINCT FROM <OLD with the allowed changes
--   applied>), so a new column is immutable by default. A no-op UPDATE
--   (SET x = x) passes; the guard compares values, not the SET list.
--   The comparison is a composite-value comparison, so a NULL field equals a
--   NULL field, and bytea compares by length + memcmp (no hex/jsonb copy of
--   the PDF, unlike a to_jsonb() comparison).
--
-- DELETE: only breeze_audit_admin with breeze.allow_audit_retention = '1' —
-- org erasure (contract_documents joins AUDIT_ADMIN_REQUIRED_TABLES in
-- services/tenantCascade.ts). The GUC alone is caller-settable; the role is
-- what authenticates it (ai_invocations precedent). Nothing cascades INTO this
-- table (org_id is NO ACTION, templates RESTRICT, every other FK SET NULL), so
-- the DELETE arm has no trigger-depth exception. Deleting a row still cascades
-- OUT to service_deliverable_evidence (ON DELETE CASCADE, 2027-01-02-100710).
--
-- PRIVILEGES: breeze_app loses table-level UPDATE, DELETE and TRUNCATE
-- (TRUNCATE defensively, as for every append-only table) and gets
-- column-level UPDATE (contract_id, org_id) back — exactly what link-later,
-- contract adopt and the merge re-point write (orgMergeRegistry REPOINT_TABLES;
-- asserted by ORG_ID_COLUMN_UPDATE_REPOINT_TABLES in
-- orgMergeRegistry.integration.test.ts). An evidence write as breeze_app is
-- therefore 42501 before the trigger runs; the trigger (55000) is the wall for
-- every other role, the table owner included. ensureAppRole.ts re-applies the
-- REVOKE and the column GRANT on every boot, after its blanket GRANT (#4371;
-- a table-level REVOKE also drops column grants, so order matters there).
-- breeze_audit_admin gets SELECT, DELETE for the erasure walk.
--
-- THREAT MODEL: this stops application code — a bug, a future bulk/admin
-- endpoint, a mistaken query — from rewriting or deleting a signed agreement.
-- It does not stop arbitrary SQL as breeze_app: breeze.scope is a GUC the app
-- sets itself, and while breeze_app holds breeze_audit_admin membership (the
-- #915 REVOKE is a manual operator step, 2026-06-11-e) it can delete through
-- that role, as org erasure does. A superuser can also skip triggers (session_replication_role,
-- DISABLE TRIGGER, TRUNCATE). Same boundary as the audit-log tables.
--
-- ROLLBACK: DROP TRIGGER contract_documents_block_update / _block_delete ON
-- contract_documents; DROP FUNCTION contract_documents_append_only(); GRANT
-- UPDATE, DELETE ON contract_documents TO breeze_app; and remove the
-- ensureAppRole block, or the next boot re-applies it. A one-off evidence
-- repair (for example a back-fill re-run) must disable the trigger explicitly
-- inside its own migration and say why; it must not weaken this function.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE,
-- REVOKE/GRANT are no-ops when already applied. Writes no rows.
SELECT set_config('breeze.scope', 'system', true);

CREATE OR REPLACE FUNCTION public.contract_documents_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed public.contract_documents;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = 'breeze_audit_admin'
       AND current_setting('breeze.allow_audit_retention', true) = '1' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'contract_documents is append-only: a signed agreement cannot be deleted',
      HINT = 'Org erasure deletes signed agreements as breeze_audit_admin with breeze.allow_audit_retention=1.';
  END IF;

  -- UPDATE: start from OLD and apply only the changes this table admits. Any
  -- other difference between NEW and that row is a rewrite of evidence.
  allowed := OLD;

  -- Filing link: any value, any caller (RLS still decides who reaches the row).
  allowed.contract_id := NEW.contract_id;

  -- Provenance pointers: cleared by their own FK's ON DELETE SET NULL only.
  IF pg_trigger_depth() > 1 THEN
    IF NEW.quote_id IS NULL THEN allowed.quote_id := NULL; END IF;
    IF NEW.quote_acceptance_id IS NULL THEN allowed.quote_acceptance_id := NULL; END IF;
    IF NEW.agreement_request_id IS NULL THEN allowed.agreement_request_id := NULL; END IF;
    IF NEW.recorded_by_user_id IS NULL THEN allowed.recorded_by_user_id := NULL; END IF;
  END IF;

  -- Org merge re-point.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     AND public.breeze_current_scope() = 'system'
     AND EXISTS (
       SELECT 1
         FROM public.organizations AS src
         JOIN public.organizations AS dst ON dst.id = NEW.org_id
        WHERE src.id = OLD.org_id
          AND src.status::text = 'merging'
          AND dst.partner_id = src.partner_id
     ) THEN
    allowed.org_id := NEW.org_id;
  END IF;

  IF NEW IS DISTINCT FROM allowed THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'contract_documents is append-only: signed agreement evidence cannot be changed',
      HINT = 'Only contract_id may change; org_id moves only with an org merge, and source pointers clear only when their target is deleted.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS contract_documents_block_update ON public.contract_documents;
CREATE TRIGGER contract_documents_block_update BEFORE UPDATE ON public.contract_documents
  FOR EACH ROW EXECUTE FUNCTION public.contract_documents_append_only();
DROP TRIGGER IF EXISTS contract_documents_block_delete ON public.contract_documents;
CREATE TRIGGER contract_documents_block_delete BEFORE DELETE ON public.contract_documents
  FOR EACH ROW EXECUTE FUNCTION public.contract_documents_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON public.contract_documents FROM breeze_app;
GRANT UPDATE (contract_id, org_id) ON public.contract_documents TO breeze_app;
GRANT SELECT, DELETE ON public.contract_documents TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON public.contract_documents FROM breeze_audit_admin;
