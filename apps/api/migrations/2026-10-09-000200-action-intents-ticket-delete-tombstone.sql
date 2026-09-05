-- #4872: a composite SET NULL without a column list also nulls org_id,
-- which is NOT NULL, aborting ticket deletion / org erasure with 23502.
-- Preserve the composite tenant boundary and automatic scope tombstone.
-- PG15+ column lists are already used by the invoice-lineage and agent
-- evidence migrations; the supported test/development stack is PG16.
ALTER TABLE action_intents
  DROP CONSTRAINT IF EXISTS action_intents_scope_ticket_org_fk;
ALTER TABLE action_intents
  ADD CONSTRAINT action_intents_scope_ticket_org_fk
  FOREIGN KEY (scope_ticket_id, org_id) REFERENCES tickets (id, org_id)
  ON DELETE SET NULL (scope_ticket_id)
  DEFERRABLE INITIALLY IMMEDIATE;
