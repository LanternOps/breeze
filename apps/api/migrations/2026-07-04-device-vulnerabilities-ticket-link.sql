-- Vulnerabilities fleet triage UI: link findings to native tickets.
-- Spec: docs/superpowers/specs/vuln-patch/2026-07-04-vulnerabilities-triage-ui-design.md
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS ticket_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'device_vulnerabilities_ticket_id_tickets_id_fk'
      AND table_name = 'device_vulnerabilities'
  ) THEN
    ALTER TABLE device_vulnerabilities
      ADD CONSTRAINT device_vulnerabilities_ticket_id_tickets_id_fk
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Partial index: most findings have no ticket; only index linked rows.
CREATE INDEX IF NOT EXISTS device_vuln_ticket_id_idx
  ON device_vulnerabilities (ticket_id) WHERE ticket_id IS NOT NULL;
