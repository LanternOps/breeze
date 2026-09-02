import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DENY_LISTED_COLUMNS,
  MIGRATIONS_DIR,
  TRIGGER_FUNCTION_NAME,
  TRIGGER_MIGRATION_FILES,
} from '../testUtils/actionIntentsTriggerDenyList';

// ---------------------------------------------------------------------------
// action_intents_block_content_update() — static half
// ---------------------------------------------------------------------------
//
// This file is the DDL/text half of the immutability contract and runs under
// the no-database unit runner (`vitest.config.ts`, blocking `test-api` job).
// The deny-list it asserts against is DISCOVERED from the migrations rather
// than hand-listed here — see `src/testUtils/actionIntentsTriggerDenyList.ts`
// for why (the trigger function is CREATE OR REPLACE'd by three migrations and
// reading only the first one is how origin_principal_kind/origin_principal_id
// shipped with zero coverage).
//
// The BEHAVIORAL half — one rejecting UPDATE per deny-listed column against a
// real Postgres, plus the positive controls for the mutable lifecycle columns
// — lives in
// `src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts`
// and runs in the blocking `integration-test` job. It used to live here behind
// `describe.runIf(!!process.env.DATABASE_URL)`, where it never executed in CI
// at all: `test-api` has no Postgres service and this file was not in
// `vitest.integration.config.ts`'s include list, so all ~28 cases silently
// skipped and approval_scope's immutability — the entire security value of the
// column — was asserted nowhere. Do not move them back.

describe('Action intents migration', () => {
  const migrationPath = join(__dirname, '../../migrations/2026-07-18-action-intents.sql');
  const sql = readFileSync(migrationPath, 'utf8');

  it('is idempotent: only IF NOT EXISTS / IF EXISTS / DO-guarded DDL', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS action_intents/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS intent_outbox/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS action_intents_org_idem_uniq/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS action_intents_org_status_idx/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS intent_outbox_unpublished_idx/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS intent_outbox_intent_id_idx/i);
    expect(sql).toMatch(/ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS intent_id/i);
    expect(sql).toMatch(
      /ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS bound_argument_digest/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_one_source_chk/i,
    );
    expect(sql).toMatch(/DROP POLICY IF EXISTS breeze_org_isolation_select ON action_intents/i);
  });

  it('never calls gen_random_bytes and never opens an inner transaction', () => {
    expect(sql).not.toMatch(/gen_random_bytes\(/i);
    expect(sql).not.toMatch(/^\s*BEGIN;/im);
    expect(sql).not.toMatch(/^\s*COMMIT;/im);
    expect(sql).toMatch(/gen_random_uuid\(\)/);
  });

  it('uses gen_random_uuid() (pgcrypto-free) for the PK default', () => {
    expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  });

  // Every column the immutability trigger guards TODAY, across all three
  // migrations that have (re)defined the function. Hand-written on purpose so
  // adding a column to the trigger is a deliberate, reviewed act — but it is
  // asserted EQUAL to the list parsed out of the effective migration below, so
  // it cannot silently drift the way it did for origin_principal_kind /
  // origin_principal_id (2026-08-06-e) and approval_scope /
  // classification_version / effect_digest (2026-08-14).
  const IMMUTABLE_CONTENT_COLUMNS = [
    // §3.1/§3.4 identity + attribution
    'org_id',
    'requested_by_user_id',
    'requesting_api_key_id',
    'source',
    // 2026-08-06-e: durable origin-principal fact
    'origin_principal_kind',
    'origin_principal_id',
    // §3.1/§3.4 action content
    'action_name',
    'action_version',
    'arguments',
    'argument_digest',
    'target_summary',
    'impact_summary',
    'reason',
    'risk_tier',
    'connection_id',
    'tenant_id',
    'idempotency_key',
    'correlation_id',
    'created_at',
    'expires_at',
    // 2026-08-14: tier-3 supervised/four_eyes classification. approval_scope's
    // immutability IS the security value of the column — an editable scope
    // would let an intent switch classification after approvers acted on the
    // original one.
    'approval_scope',
    'classification_version',
    'effect_digest',
    // 2026-09-05-a: the originating agent run is part of the intent's
    // immutable content, for the same reason as the origin fields above — an
    // intent whose attributed run could be swapped after approval would
    // defeat release revalidation.
    'requesting_agent_run_id',
    // 2026-09-23 (P2-2, #4189): typed target scope. scope_kind is a plain
    // deny-listed column (never changes post-creation). scope_device_id's
    // guard is actually conditional — `NEW.scope_device_id IS DISTINCT FROM
    // OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL` — so a
    // non-null->NULL tombstone (the device-delete FK's ON DELETE SET NULL)
    // is allowed through, but the regex parser can't see the AND clause and
    // lists it as a plain deny-listed column regardless. That is fine: this
    // list's job is drift detection, and the column genuinely is guarded.
    'scope_kind',
    'scope_device_id',
    // 2026-09-25 (P2-4, #4191): same conditional-guard shape as
    // scope_device_id above — `NEW.scope_ticket_id IS DISTINCT FROM
    // OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL` permits only
    // the non-null->NULL tombstone transition (the ticket-delete FK's ON
    // DELETE SET NULL, or a moveOrg detach step), never a retarget.
    'scope_ticket_id',
  ] as const;

  // Deliberately MUTABLE. release_by is written by the approve fan-in
  // (routes/approvals.ts stamps the RELEASE_LEASE_MS lease in the same CAS
  // that flips the intent to approved) and approval_expires_at is a lifecycle
  // deadline; adding either to the deny-list would break the decide path at
  // runtime. Asserted absent here AND exercised positively against a live DB
  // below, so a future "tighten the trigger" change fails a test instead of
  // production.
  const MUTABLE_LIFECYCLE_COLUMNS = [
    'status',
    'approval_expires_at',
    'release_by',
    'decided_at',
    'decided_by_user_id',
    'decided_assurance_level',
    'decided_via',
    'execution_started_at',
    'executed_at',
    'result',
    'error_code',
    'requesting_client_label',
  ] as const;

  it('discovers every migration that redefines the immutability trigger, base first', () => {
    // The base migration CREATEs the table; every later definition is a
    // CREATE OR REPLACE that must sort AFTER it, or a fresh-DB replay applies
    // the replacement before the function's table exists.
    expect(TRIGGER_MIGRATION_FILES[0]).toBe('2026-07-18-action-intents.sql');
    expect(TRIGGER_MIGRATION_FILES.length).toBeGreaterThan(1);
    for (const filename of TRIGGER_MIGRATION_FILES.slice(1)) {
      const body = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      expect(
        body,
        `${filename} must use CREATE OR REPLACE FUNCTION (a bare CREATE is not re-appliable)`,
      ).toMatch(
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${TRIGGER_FUNCTION_NAME}`, 'i'),
      );
    }
  });

  it('declares the immutability trigger over exactly the content columns', () => {
    expect(sql).toMatch(/action_intents_block_content_update/);
    expect(sql).toMatch(/action_intents_immutable_trg/);
    expect(sql).toMatch(/RAISE EXCEPTION 'action_intents content is immutable'/);

    // Drift gate: the hand-written list must be exactly the trigger's
    // deny-list as of the LAST migration that defines it. Adding a column to
    // the trigger without adding it here (or vice versa) fails right here.
    expect(DENY_LISTED_COLUMNS).toEqual([...IMMUTABLE_CONTENT_COLUMNS].sort());

    // ...and the lifecycle columns must NOT be in it.
    for (const lifecycleCol of MUTABLE_LIFECYCLE_COLUMNS) {
      expect(
        DENY_LISTED_COLUMNS,
        `${lifecycleCol} must stay mutable — it is written after creation`,
      ).not.toContain(lifecycleCol);
    }
  });

  it('enables and forces RLS on action_intents with breeze_has_org_access policies', () => {
    expect(sql).toMatch(/ALTER TABLE action_intents ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE action_intents FORCE ROW LEVEL SECURITY/);
    const selectPolicyMatches = sql.match(
      /CREATE POLICY breeze_org_isolation_select ON action_intents[\s\S]*?breeze_has_org_access\(org_id\)/,
    );
    expect(selectPolicyMatches).not.toBeNull();
    for (const cmd of ['insert', 'update', 'delete']) {
      expect(sql.toLowerCase()).toMatch(
        new RegExp(`create policy breeze_org_isolation_${cmd} on action_intents`),
      );
    }
  });

  it('leaves intent_outbox truly unscoped, with no RLS and no policies (matches device_commands)', () => {
    // FORCE ROW LEVEL SECURITY with zero policies is default-DENY for every
    // access path — breeze_app is NOSUPERUSER NOBYPASSRLS and
    // withSystemDbAccessContext only sets the breeze.scope GUC, it does not
    // bypass RLS. So intent_outbox must carry NO ENABLE/FORCE ROW LEVEL
    // SECURITY at all, same as device_commands, or every INSERT 42501s.
    expect(sql).not.toMatch(/ALTER TABLE intent_outbox ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE intent_outbox FORCE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*ON intent_outbox/i);
  });

  it('cascades intent_outbox and approval_requests.intent_id from action_intents', () => {
    expect(sql).toMatch(
      /intent_id UUID NOT NULL REFERENCES action_intents\(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS intent_id UUID\s+REFERENCES action_intents\(id\) ON DELETE CASCADE/,
    );
  });

  it('indexes intent_outbox.intent_id (matches the Drizzle intentIdIdx declaration)', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS intent_outbox_intent_id_idx\s+ON intent_outbox \(intent_id\)/,
    );
  });

  it('enforces at most one source link on approval_requests, permitting all-NULL', () => {
    expect(sql).toMatch(/CONSTRAINT approval_requests_one_source_chk/);
    expect(sql).toMatch(/<=\s*1/);
  });

  it('preflights the approval_requests_one_source_chk constraint with a warn-only row count', () => {
    // Finding 3: a diagnosable, non-destructive COUNT before the constraint
    // add — must appear before the DROP CONSTRAINT/ADD CONSTRAINT pair and
    // must not DELETE or UPDATE any rows.
    const constraintIdx = sql.indexOf('ALTER TABLE approval_requests DROP CONSTRAINT');
    const preflightIdx = sql.indexOf('SELECT COUNT(*) INTO n');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(constraintIdx);
    const preflightBlock = sql.slice(sql.lastIndexOf('DO $$', constraintIdx), constraintIdx);
    expect(preflightBlock).toMatch(/GET DIAGNOSTICS|SELECT COUNT\(\*\) INTO n/);
    expect(preflightBlock).toMatch(/RAISE WARNING/);
    expect(preflightBlock).not.toMatch(/\bDELETE\b|\bUPDATE\b/i);
  });

  it('enforces exactly one actor on action_intents', () => {
    expect(sql).toMatch(/CONSTRAINT action_intents_one_actor_chk/);
    expect(sql).toMatch(
      /CHECK \(\(requested_by_user_id IS NULL\) <> \(requesting_api_key_id IS NULL\)\)/,
    );
  });

  it('declares the source/status/event_type CHECK-constrained value lists exactly as spec\'d', () => {
    expect(sql).toMatch(/source TEXT NOT NULL CHECK \(source IN \('chat','mcp_api'\)\)/);
    expect(sql).toMatch(
      /status TEXT NOT NULL DEFAULT 'pending_approval'\s+CHECK \(status IN \('pending_approval','approved','executing','completed','failed','rejected','expired','cancelled'\)\)/,
    );
    expect(sql).toMatch(
      /event_type TEXT NOT NULL CHECK \(event_type IN \('intent_created','intent_approved'\)\)/,
    );
  });
});
