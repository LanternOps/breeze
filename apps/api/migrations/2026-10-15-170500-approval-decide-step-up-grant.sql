-- #5601: reusable "recent ceremony" step-up grant for consecutive approvals.
--
-- A decision that reuses an `approval_decide` grant keeps its honest
-- decided_assurance_level / decided_via / authenticator_device_id (they
-- describe a ceremony that really happened, minutes earlier), so without this
-- column a REUSED L3 row would be byte-identical to a fresh one and the
-- approval ledger would be claiming a ceremony that did not happen.
--
-- Written inside the same transaction as the decision itself. The equivalent
-- audit EVENT is emitted post-commit, only when the linked-intent CAS is won,
-- through a writer with a droppable in-memory retry queue — so the event is a
-- convenience for dashboards and this column is the guarantee.
--
-- NOT NULL DEFAULT false is a true statement about history, not a placeholder:
-- no grants existed before this migration, so every existing row really was
-- decided by its own ceremony.
--
-- `approval_requests` has no org_id and is in neither
-- CORE_ORG_CASCADE_DELETE_ORDER nor CORE_TENANT_EXPORT_POLICY, so this
-- ADD COLUMN carries no cascade or export-policy registration obligation.
-- Writes no rows, so it needs no `breeze.scope` elevation.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS decided_via_step_up_grant boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN approval_requests.decided_via_step_up_grant IS
  'TRUE when this decision reused an approval_decide step-up grant instead of running its own ceremony (#5601). The assurance columns still describe the original, real ceremony.';
