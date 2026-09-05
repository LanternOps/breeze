import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeMigrationDml, findUnscopedMigrationDml, escapeRegExp } from './migrationRlsScope';

/**
 * Guard for issue #4518: a migration that writes rows without first electing
 * system scope is not portable off a superuser/BYPASSRLS connection.
 *
 * THE CLASS. `public.breeze_current_scope()` defaults to 'none'
 * (`0012-tenant-rls-deny-default.sql`), and once a table is
 * `FORCE ROW LEVEL SECURITY` its policies bind the table OWNER too — which is
 * the role migrations run as. So on a connection that does not bypass RLS,
 * `UPDATE`/`DELETE` in a migration match ZERO rows with no error (the backfill
 * reports a truthful-looking "0 cleaned" and moves on), and `INSERT` aborts the
 * migration with 42501. The fix is one line before the DML, already the house
 * pattern — see `2026-09-30-100000-rls-scoped-backfill-replay.sql`:
 *
 *   SELECT set_config('breeze.scope', 'system', true);
 *
 * `is_local = true` scopes it to autoMigrate's per-file transaction.
 *
 * WHY THE RULE COVERS EVERY TABLE, not a derived FORCE-RLS set. The issue
 * proposed deriving the forced set by grepping `ALTER TABLE … FORCE ROW LEVEL
 * SECURITY`. That is unsound: the two sweeps in `0008-tenant-rls.sql` and
 * `2026-05-03-tenant-rls-force-and-invites.sql` force every table carrying an
 * `org_id` via `EXECUTE format(…)` over a catalog query, naming no table at
 * all, and several later migrations force lists of tables the same way. A
 * literal grep therefore under-counts badly. Measured against a fully migrated
 * database (`pg_class.relforcerowsecurity`), 425 of 442 public tables are
 * forced; the 17 that are not are global catalogs (`agent_versions`,
 * `permissions`, `patches`, `device_commands`, …). Requiring the wrapper for
 * ALL migration DML costs 3 extra baseline files versus perfect ground truth
 * and needs no table registry, no schema import and no ordering model — and it
 * cannot silently rot when the next table is forced dynamically. Setting system
 * scope is harmless on a table without RLS.
 *
 * EVIDENCE (local, PG16, A/B with the RLS attribute as the sole variable —
 * `apps/api/scripts/check-migrations-nonsuperuser.ts` against a fresh database):
 *   - migration role WITH BYPASSRLS: full set applies, OK.
 *   - same role NOBYPASSRLS: aborts at
 *     `2026-05-22-snmp-multi-vendor-templates.sql` with 42501 "new row violates
 *     row-level security policy for table snmp_templates".
 * So every deployment alive today migrates as superuser or BYPASSRLS — nothing
 * in the field is silently no-op'ing right now. The 122 baseline files below
 * are the debt that has to be paid before a plain (non-BYPASSRLS) owner role
 * can ever run this migration set, and the guard is what stops it growing.
 *
 * NOT COVERED: a forced table read as a SELECT source (`INSERT INTO a SELECT …
 * FROM forced_b`) filters silently the same way, but the target-side rule here
 * already requires the wrapper for that statement, which fixes both halves.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function listMigrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}-.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Newest migration on disk when this guard landed. Every baseline entry must
 * sort at or before it, which is what stops the baseline being used as an
 * escape hatch: a NEW migration necessarily sorts after this line, so it cannot
 * be silenced by appending a filename — RAISING THIS CONSTANT IS NEVER THE FIX.
 */
const BASELINE_CUTOFF = '2026-10-08-101000-cascade-device-org-move-vuln-ticket-detach.sql';

/**
 * Shipped migrations that write rows without electing system scope, and how
 * many such statements each contains. Content-hash immutable, so they can only
 * ever be repaired by a fix-forward migration — see the PR for #4518 for the
 * audit. This map is asserted EXACTLY in both directions: an entry that no
 * longer offends must be deleted, and a new offender cannot be added.
 */
const UNSCOPED_DML_BASELINE: Readonly<Record<string, number>> = {
  '0016-be19-device-ip-history.sql': 1,
  '0018-network-alert-templates.sql': 4,
  '0025-device-approval.sql': 3,
  '0031-zz-dns-security-hardening.sql': 1,
  '0058-device-role-classification.sql': 4,
  '0060-alerting-system.sql': 1,
  '0068-fix-script-typo.sql': 1,
  '0083-backup-mode-targets.sql': 1,
  '0085-patch-policy-kind.sql': 1,
  '0092-recovery-signing-and-boot-media.sql': 1,
  '2026-04-01-backup-verification-type-normalization.sql': 1,
  '2026-04-11-bucket-c-phase-1-inventory-rls.sql': 5,
  '2026-04-11-bucket-c-phase-2-security-patch-rls.sql': 4,
  '2026-04-11-bucket-c-phase-3-device-state-rls.sql': 5,
  '2026-04-11-bucket-c-phase-4-session-execution-rls.sql': 5,
  '2026-04-11-device-metrics-org-id.sql': 1,
  '2026-04-11-device-metrics-rls-policies.sql': 1,
  '2026-04-11-users-rls.sql': 1,
  '2026-04-24-oauth-client-partner-grants.sql': 1,
  '2026-05-02-report-permissions.sql': 5,
  '2026-05-03-billing-manage-permission.sql': 1,
  '2026-05-03-permission-scope-hardening.sql': 3,
  '2026-05-04-reports-export-grandfather.sql': 1,
  '2026-05-13-c-third-party-package-catalog-seed.sql': 1,
  '2026-05-18-device-child-orgid-cascade.sql': 1,
  '2026-05-22-snmp-multi-vendor-templates.sql': 28,
  '2026-05-22-unifi-snmp-templates.sql': 3,
  '2026-05-25-b-audit-log-checksum-chain.sql': 1,
  '2026-05-25-c-audit-log-checksum-canonical-fix.sql': 1,
  '2026-05-25-f-role-force-mfa.sql': 1,
  '2026-05-31-script-execution-batches-org-id.sql': 1,
  '2026-05-31-user-notifications-link-relative-check.sql': 1,
  '2026-06-09-a-native-ticketing-core.sql': 5,
  '2026-06-09-users-disabled-reason.sql': 1,
  '2026-06-10-c-ticket-category-tenant-fks.sql': 2,
  '2026-06-11-h-audit-chain-seal-and-verify.sql': 1,
  '2026-06-11-j-avatar-bytea-columns.sql': 1,
  '2026-06-12-a-huntress-partner-mapping.sql': 3,
  '2026-06-12-a-ticketing-time-parts.sql': 4,
  '2026-06-13-a-ticketing-configuration.sql': 2,
  '2026-06-13-c-partner-timezone-column.sql': 1,
  '2026-06-13-catalog-partner-axis-rls.sql': 4,
  '2026-06-14-product-catalog.sql': 6,
  '2026-06-15-a-invoice-engine.sql': 5,
  '2026-06-15-d-recurring-contracts.sql': 4,
  '2026-06-16-quotes.sql': 5,
  '2026-06-18-neutralize-orphaned-users.sql': 1,
  '2026-06-19-billing-roles.sql': 6,
  '2026-06-20-role-permissions-unique.sql': 1,
  '2026-06-22-stripe-key-status-check.sql': 1,
  '2026-06-24-config-policy-run-tenant-key-backfill.sql': 1,
  '2026-06-25-sso-admin-permission-backfill.sql': 2,
  '2026-06-26-sso-verified-domains.sql': 1,
  '2026-06-27-a-sentinelone-partner-mapping.sql': 3,
  '2026-06-27-a-update-rings-partner-scope.sql': 1,
  '2026-06-27-b-patch-approvals-partner-scope.sql': 2,
  '2026-06-27-c-default-update-ring-dedup.sql': 9,
  '2026-06-29-b-topology-write-permission.sql': 3,
  '2026-06-29-topology-provenance.sql': 3,
  '2026-06-29-vuln-risk-accept-permission.sql': 6,
  '2026-07-01-pam-uac-opt-in-grandfathering.sql': 1,
  '2026-07-02-installer-bootstrap-token-multi-use.sql': 1,
  '2026-07-04-partner-login-branding-accent-check.sql': 1,
  '2026-07-04-user-sso-identities-unique-external.sql': 1,
  '2026-07-11-ai-sessions-read-all-permission.sql': 2,
  '2026-07-11-refresh-token-storage-hardening.sql': 2,
  '2026-07-13-m365-control-plane-foundation.sql': 3,
  '2026-07-14-pax8-direct-draft-uniqueness.sql': 1,
  '2026-07-15-a-ticket-mailbox-verified-ownership.sql': 3,
  '2026-07-15-auth-epochs-and-family-expiry.sql': 1,
  '2026-07-15-b-ticket-mailbox-permissions.sql': 6,
  '2026-07-16-sso-session-binding-and-provider-version.sql': 1,
  '2026-07-18-b-approvals-decide-seed.sql': 2,
  '2026-07-18-c-approvals-decide-seed-cleanup.sql': 1,
  '2026-07-20-partner-export-reconstruction-material-state.sql': 2,
  '2026-07-24-partner-export-configuration-material-state.sql': 1,
  '2026-07-26-scrub-plaintext-temp-passwords.sql': 4,
  '2026-07-28-software-deployments-dispatched-at.sql': 1,
  '2026-07-29-breeze-p-normalize-s3-endpoints.sql': 2,
  '2026-08-03-c-quotes-fulfill-permission.sql': 2,
  '2026-08-06-a-report-site-scope.sql': 2,
  '2026-08-06-d-device-mtls-certificate-history.sql': 1,
  '2026-08-08-organization-external-links.sql': 1,
  '2026-08-08-proxy-session-lifetime.sql': 3,
  '2026-08-11-variables-permissions.sql': 3,
  '2026-08-12-device-identity-collision-alert-template.sql': 1,
  '2026-08-13-ring-third-party-auto-approve-backfill.sql': 3,
  '2026-08-14-a-partner-document-theme.sql': 2,
  '2026-08-14-intent-approval-scope-and-deadlines.sql': 1,
  '2026-08-15-intent-release-lease-backfill.sql': 1,
  '2026-08-15-snmp-poll-attempt-backoff.sql': 1,
  '2026-08-18-drop-organizations-accounting-columns.sql': 1,
  '2026-08-19-contacts.sql': 5,
  '2026-08-20-discovered-asset-detection-source.sql': 1,
  '2026-08-20-installer-bootstrap-token-usage-kind.sql': 1,
  '2026-08-21-park-asset-checkout-default-off.sql': 1,
  '2026-08-23-software-version-url-file-type.sql': 1,
  '2026-08-24-inbound-enabled-backfill.sql': 1,
  '2026-08-25-alert-templates-one-owner.sql': 1,
  '2026-08-27-a-supported-currencies.sql': 1,
  '2026-08-27-b-org-currency-and-fks.sql': 5,
  '2026-08-29-a-catalog-item-prices.sql': 1,
  '2026-08-29-b-catalog-cost-currency-and-org-pricing-currency.sql': 4,
  '2026-08-30-ticketing-currency.sql': 5,
  '2026-09-01-a-bundle-allocation-currency.sql': 1,
  '2026-09-01-b-document-locale-backfill.sql': 3,
  '2026-09-02-a-invoice-line-source-contract-lineage.sql': 1,
  '2026-09-03-ai-agents-permissions.sql': 3,
  '2026-09-11-a-webhook-delivery-event-uniqueness.sql': 1,
  '2026-09-11-b-incident-atomic-winners.sql': 2,
  '2026-09-11-f-alert-notifications-send-identity.sql': 1,
  '2026-09-12-agent-rollback-protocol.sql': 2,
  '2026-09-16-pam-actuation-lifecycle.sql': 1,
  '2026-09-22-ai-alert-verdicts-live-unique.sql': 2,
  '2026-09-25-a-automation-resource-bindings.sql': 5,
  '2026-09-25-b-cross-site-restore-permission.sql': 2,
  '2026-09-25-c-recovery-authorization-subject.sql': 6,
  '2026-09-27-technician-ticket-write-permissions.sql': 1,
  '2026-09-28-quickbooks-entity-mappings.sql': 1,
  '2026-10-06-100101-authenticator-attestation-state.sql': 2,
  '2026-10-08-100600-audit-retention-manage-permission.sql': 2,
  '2026-10-08-100700-audit-retention-policies-org-unique.sql': 1,
};

describe('migration DML runs under system scope', () => {
  const files = listMigrationFilenames();

  it('discovers migration files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('adds no migration that writes rows without electing system scope', () => {
    const offenders: Record<string, number> = {};
    for (const file of files) {
      const unscoped = findUnscopedMigrationDml(
        readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
      );
      if (unscoped.length > 0) offenders[file] = unscoped.length;
    }

    const added = Object.keys(offenders).filter((file) => !(file in UNSCOPED_DML_BASELINE));
    const detail = added
      .flatMap((file) =>
        findUnscopedMigrationDml(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')).map(
          (statement) =>
            `  ${file}:${statement.line}  ${statement.kind} ${statement.table}` +
            (statement.dynamic ? ' (EXECUTE-built)' : ''),
        ),
      )
      .join('\n');

    expect(
      offenders,
      added.length === 0
        ? 'A baseline entry no longer offends (or its statement count changed). ' +
          'Update UNSCOPED_DML_BASELINE to match — do not delete the assertion.'
        : `Migration DML without system scope (issue #4518):\n${detail}\n\n` +
          `On a connection that does not bypass RLS these UPDATE/DELETEs match ZERO\n` +
          `rows silently, and INSERTs abort the migration with 42501. Add ONE line\n` +
          `before the first write in each file:\n\n` +
          `  SELECT set_config('breeze.scope', 'system', true);\n\n` +
          `(or PERFORM set_config('breeze.scope', 'system', true); as the first\n` +
          `statement inside a DO block). Do NOT add the file to\n` +
          `UNSCOPED_DML_BASELINE — that list is frozen at ${BASELINE_CUTOFF}.\n` +
          `Reference: apps/api/migrations/2026-09-30-100000-rls-scoped-backfill-replay.sql`,
    ).toEqual(UNSCOPED_DML_BASELINE);
  });

  it('freezes the baseline at the cutoff so a new migration cannot join it', () => {
    const past = Object.keys(UNSCOPED_DML_BASELINE).filter(
      (file) => file.localeCompare(BASELINE_CUTOFF) > 0,
    );
    expect(
      past,
      `UNSCOPED_DML_BASELINE entries newer than the cutoff ${BASELINE_CUTOFF}. ` +
        'A new migration must set system scope, not join the baseline.',
    ).toEqual([]);

    // A cutoff naming a file that does not exist would silently stop guarding.
    expect(listMigrationFilenames()).toContain(BASELINE_CUTOFF);
  });

  it('keeps every baseline entry on disk', () => {
    const onDisk = new Set(files);
    const missing = Object.keys(UNSCOPED_DML_BASELINE).filter((file) => !onDisk.has(file));
    expect(
      missing,
      `Baseline names migration(s) that are no longer on disk: ${missing.join(', ')}. ` +
        'A shipped migration was renamed or deleted, which re-applies it under the new ' +
        'name on every already-migrated database.',
    ).toEqual([]);
  });
});

/**
 * The guard above is only worth its green if the analyzer actually
 * discriminates. These drive it against hand-written SQL in both directions —
 * a parser that flagged nothing, or flagged everything, would still make the
 * baseline assertion pass on the day it was generated.
 */
describe('analyzeMigrationDml', () => {
  const scope = "SELECT set_config('breeze.scope', 'system', true);\n";

  const unscoped = (sql: string) =>
    findUnscopedMigrationDml(sql).map((d) => `${d.kind} ${d.table}${d.dynamic ? ' *' : ''}`);

  it('flags a bare write and clears the same write once scope is elected', () => {
    const dml = "UPDATE devices SET status = 'active' WHERE status IS NULL;\n";
    expect(unscoped(dml)).toEqual(['UPDATE devices']);
    expect(unscoped(scope + dml)).toEqual([]);
    // Order matters: elevating AFTER the write does not retroactively cover it.
    expect(unscoped(dml + scope)).toEqual(['UPDATE devices']);
  });

  it('detects every writing verb', () => {
    expect(unscoped('DELETE FROM alerts WHERE id IS NULL;')).toEqual(['DELETE alerts']);
    expect(unscoped("INSERT INTO roles (name) VALUES ('x');")).toEqual(['INSERT roles']);
    expect(unscoped('MERGE INTO tickets t USING s ON t.id = s.id;')).toEqual(['MERGE tickets']);
  });

  it('normalizes quoted and schema-qualified targets', () => {
    expect(unscoped('UPDATE "device_ip_history" SET is_active = false;')).toEqual([
      'UPDATE device_ip_history',
    ]);
    expect(unscoped('DELETE FROM public.device_metrics dm WHERE dm.id IS NULL;')).toEqual([
      'DELETE device_metrics',
    ]);
  });

  it('sees a write fronted by a CTE', () => {
    expect(
      unscoped(
        'WITH ranked AS (SELECT id FROM verdicts)\nUPDATE verdicts v SET superseded_by = 1 FROM ranked;',
      ),
    ).toEqual(['UPDATE verdicts']);
  });

  it('sees a write inside a DO block, and honours PERFORM elevation inside it', () => {
    const body = (prefix: string) =>
      `DO $$\nBEGIN\n  ${prefix}UPDATE devices SET status = 'x';\nEND $$;`;
    expect(unscoped(body(''))).toEqual(['UPDATE devices']);
    expect(unscoped(body("PERFORM set_config('breeze.scope', 'system', true);\n  "))).toEqual([]);
    // File-level elevation also reaches into a later DO block: autoMigrate
    // wraps the whole file in one transaction.
    expect(unscoped(scope + body(''))).toEqual([]);
  });

  it('sees EXECUTE-built dynamic DML but not a diagnostic string that merely names one', () => {
    expect(
      unscoped("DO $$\nBEGIN\n  EXECUTE format('UPDATE %I SET org_id = NULL', tbl);\nEND $$;"),
    ).toEqual(['UPDATE %i *']);
    expect(
      unscoped("DO $$\nBEGIN\n  RAISE NOTICE 'skipping UPDATE devices SET status';\nEND $$;"),
    ).toEqual([]);
  });

  it('ignores the non-DML uses of the same keywords', () => {
    expect(unscoped('GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO breeze_app;')).toEqual([]);
    expect(unscoped('CREATE POLICY p ON devices FOR UPDATE USING (true);')).toEqual([]);
    expect(
      unscoped('CREATE TRIGGER t AFTER UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION f();'),
    ).toEqual([]);
    expect(
      unscoped(
        'ALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES c(id) ON DELETE CASCADE ON UPDATE NO ACTION;',
      ),
    ).toEqual([]);
    expect(unscoped('SELECT id FROM devices FOR UPDATE;')).toEqual([]);
  });

  it('ignores writes that are only mentioned, not executed', () => {
    expect(unscoped('-- UPDATE devices SET status = 1;\nALTER TABLE devices ADD COLUMN x int;')).toEqual([]);
    expect(unscoped('/* UPDATE devices SET status = 1; */\nALTER TABLE devices ADD COLUMN x int;')).toEqual([]);
    // A routine body runs later, under its caller's scope — not a migration write.
    expect(
      unscoped(
        "CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  UPDATE devices SET status = 'x';\n  RETURN NEW;\nEND $$;",
      ),
    ).toEqual([]);
  });

  it('does not credit a transaction-local elevation across an @no-transaction file', () => {
    // autoMigrate sends each statement of such a file as its own command, so a
    // top-level set_config has already expired by the next statement.
    const file = `-- @no-transaction\n${scope}UPDATE devices SET status = 'x';\n`;
    expect(unscoped(file)).toEqual(['UPDATE devices']);
    // Same statement, so it still counts.
    const sameStatement = `-- @no-transaction\nDO $$\nBEGIN\n  PERFORM set_config('breeze.scope', 'system', true);\n  UPDATE devices SET status = 'x';\nEND $$;`;
    expect(unscoped(sameStatement)).toEqual([]);
  });

  it('reports line numbers and scope state for every write, not just the unscoped ones', () => {
    // `scope` already ends in a newline, so the blank line puts UPDATE on 3.
    const analyzed = analyzeMigrationDml(`${scope}\nUPDATE a SET x = 1;\nDELETE FROM b;`);
    expect(analyzed.map((d) => [d.kind, d.table, d.line, d.scoped])).toEqual([
      ['UPDATE', 'a', 3, true],
      ['DELETE', 'b', 4, true],
    ]);
  });
});

/**
 * Regressions for the review findings on this PR. Each one is a shape that made
 * the analyzer silently WRONG — either a real unscoped write that vanished from
 * the report, or a write credited as scoped by text that never ran.
 */
describe('analyzeMigrationDml — review regressions', () => {
  const unscoped = (sql: string) =>
    findUnscopedMigrationDml(sql).map((d) => `${d.kind} ${d.table}${d.dynamic ? ' *' : ''}`);

  it('does not let an E-string escape swallow the rest of the file', () => {
    // `E'it\'s'` keeps the backslash escape, so the literal does NOT end at the
    // inner quote. Mis-parsing it desynchronised the scan and made every later
    // statement disappear from the report entirely.
    const sql =
      "UPDATE organizations SET name = E'it\\'s a note' WHERE id = 1;\n" +
      'DELETE FROM sensitive_secrets WHERE org_id IS NOT NULL;\n';
    expect(unscoped(sql)).toEqual(['UPDATE organizations', 'DELETE sensitive_secrets']);
  });

  it('does not credit an elevation that is only quoted, never executed', () => {
    // A COMMENT payload is data. Treating it as code marked every later write
    // in the file as scoped — and this PR's own docs make that text likely to
    // appear near a migration.
    const sql =
      "COMMENT ON TABLE devices IS $$call set_config('breeze.scope', 'system', true) first$$;\n" +
      "UPDATE devices SET status = 'x';\n";
    expect(unscoped(sql)).toEqual(['UPDATE devices']);
  });

  it('scans the body of a function this same file goes on to call', () => {
    const body =
      'CREATE OR REPLACE FUNCTION cleanup_orphans() RETURNS void AS $body$\n' +
      'BEGIN\n  DELETE FROM devices WHERE org_id IS NULL;\nEND;\n$body$ LANGUAGE plpgsql;\n';
    // Defined and invoked here, so the DELETE really runs at migration time.
    expect(unscoped(`${body}SELECT cleanup_orphans();\n`)).toEqual(['DELETE devices']);
    // Defined only — it runs later, under whatever scope its caller has.
    expect(unscoped(body)).toEqual([]);
    // A trigger wiring the function up is not a migration-time call.
    expect(
      unscoped(`${body}CREATE TRIGGER t AFTER INSERT ON devices EXECUTE FUNCTION cleanup_orphans();\n`),
    ).toEqual([]);
  });

  it('ignores a CREATE RULE body, whose DML fires on later writes', () => {
    expect(
      unscoped(
        'CREATE RULE audit_on_update AS ON UPDATE TO devices\n' +
          '  DO ALSO INSERT INTO audit_log (device_id) VALUES (OLD.id);\n',
      ),
    ).toEqual([]);
  });

  it('flags CREATE TABLE AS SELECT but not a plain CREATE TABLE', () => {
    expect(unscoped('CREATE TEMP TABLE dedup ON COMMIT DROP AS SELECT id FROM devices;')).toEqual([
      'CTAS dedup',
    ]);
    // Regression: a lazy cross-statement match made this pick up the AS SELECT
    // from a *later* statement and flag the plain CREATE TABLE too.
    expect(
      unscoped(
        'CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY, n int);\nSELECT 1 AS SELECTED;\n',
      ),
    ).toEqual([]);
    expect(unscoped('CREATE TABLE t (id int GENERATED ALWAYS AS (1) STORED);')).toEqual([]);
  });

  it('flags COPY … FROM, and deliberately ignores TRUNCATE', () => {
    expect(unscoped("COPY devices FROM '/tmp/d.csv' WITH (FORMAT csv);")).toEqual(['COPY devices']);
    // TRUNCATE bypasses RLS outright, so electing scope changes nothing.
    expect(unscoped('TRUNCATE TABLE devices;')).toEqual([]);
  });

  it('honours ONLY, and detects dynamic DML for every verb', () => {
    expect(unscoped("UPDATE ONLY devices SET status = 'x';")).toEqual(['UPDATE devices']);
    expect(unscoped('DELETE FROM ONLY devices WHERE id IS NULL;')).toEqual(['DELETE devices']);
    const exec = (stmt: string) => `DO $$\nBEGIN\n  EXECUTE format('${stmt}', tbl);\nEND $$;`;
    expect(unscoped(exec('DELETE FROM %I WHERE x = 1'))).toEqual(['DELETE %i *']);
    expect(unscoped(exec('INSERT INTO %I (a) VALUES (1)'))).toEqual(['INSERT %i *']);
    expect(unscoped(exec('MERGE INTO %I t USING s ON t.id = s.id'))).toEqual(['MERGE %i *']);
  });

  it('sees CTE-fronted writes for verbs other than UPDATE', () => {
    expect(
      unscoped('WITH doomed AS (SELECT id FROM t) DELETE FROM tickets WHERE id IN (SELECT id FROM doomed);'),
    ).toEqual(['DELETE tickets']);
    expect(
      unscoped('WITH moved AS (INSERT INTO archive (id) SELECT id FROM devices RETURNING id) SELECT 1;'),
    ).toEqual(['INSERT archive']);
  });

  it('clears every verb once scope is elected, not just UPDATE', () => {
    const scope = "SELECT set_config('breeze.scope', 'system', true);\n";
    for (const dml of [
      'DELETE FROM alerts WHERE id IS NULL;',
      "INSERT INTO roles (name) VALUES ('x');",
      'CREATE TEMP TABLE d AS SELECT id FROM devices;',
    ]) {
      expect(unscoped(dml).length).toBe(1);
      expect(unscoped(scope + dml)).toEqual([]);
    }
  });
});

describe('escapeRegExp', () => {
  it('escapes backslash along with every other regex metacharacter', () => {
    // CodeQL js/incomplete-sanitization: an earlier version of this escaper
    // (`name.replace(/[$]/g, '\\$&')`, used to embed a routine name in a
    // RegExp) escaped `$` but left a literal backslash untouched. A stray
    // backslash then combines with whatever the escaper emits next instead
    // of being matched literally, desynchronising the built pattern. Proof:
    // wrapping the escaped output in `^...$` must match the original string
    // back, verbatim, for input containing a backslash plus other
    // metacharacters.
    const input = 'a\\$b.c*d';
    const escaped = escapeRegExp(input);
    expect(new RegExp(`^${escaped}$`).test(input)).toBe(true);
    expect(new RegExp(`^${escaped}$`).test('aXb.c*d')).toBe(false);
  });
});
