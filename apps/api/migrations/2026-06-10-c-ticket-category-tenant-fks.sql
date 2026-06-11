-- Cross-partner FK hardening (ticketing v1 follow-up).
-- tickets.category_id and ticket_categories.parent_id were plain id FKs, so a
-- forged request could reference another partner's category. App-layer checks
-- land in the same PR; these composite FKs enforce the boundary at the DB
-- level too (precedent: users (org_id, partner_id) -> organizations).
--
-- The original simple FKs (ON DELETE SET NULL) are kept: their per-row SET
-- NULL runs before the composite NO ACTION check at end of statement, so
-- category deletes still null out references cleanly. MATCH SIMPLE means rows
-- with NULL category_id/parent_id (or legacy NULL tickets.partner_id) pass.

-- FK target: (id, partner_id) must be unique.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_id_partner_id_key') THEN
    ALTER TABLE ticket_categories ADD CONSTRAINT ticket_categories_id_partner_id_key UNIQUE (id, partner_id);
  END IF;
END $$;

-- Clean up any pre-existing cross-partner references before adding the FKs
-- (idempotent; no-op on healthy data).
UPDATE tickets t SET category_id = NULL
WHERE t.category_id IS NOT NULL AND t.partner_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ticket_categories tc
    WHERE tc.id = t.category_id AND tc.partner_id = t.partner_id
  );

UPDATE ticket_categories c SET parent_id = NULL
WHERE c.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ticket_categories p
    WHERE p.id = c.parent_id AND p.partner_id = c.partner_id
  );

-- A ticket's category must belong to the ticket's partner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_category_partner_fkey') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_category_partner_fkey
      FOREIGN KEY (category_id, partner_id) REFERENCES ticket_categories (id, partner_id);
  END IF;
END $$;

-- A category's parent must belong to the same partner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_parent_partner_fkey') THEN
    ALTER TABLE ticket_categories ADD CONSTRAINT ticket_categories_parent_partner_fkey
      FOREIGN KEY (parent_id, partner_id) REFERENCES ticket_categories (id, partner_id);
  END IF;
END $$;
