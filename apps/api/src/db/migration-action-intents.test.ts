import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { eq, sql as sqlTag } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from './index';
import { partners, organizations, users, actionIntents } from './schema';
import type { NewActionIntent } from './schema/actionIntents';

// ---------------------------------------------------------------------------
// action_intents_block_content_update() — discovered, not hand-listed
// ---------------------------------------------------------------------------
//
// The immutability trigger's function is CREATE OR REPLACE'd by more than one
// migration (2026-07-18 created it; 2026-08-06-e added the origin-principal
// columns; 2026-08-14 added approval_scope/classification_version/
// effect_digest). Reading only the 2026-07-18 file — which this suite used to
// do — tests the trigger as it existed in July, not as it exists today, and
// that is exactly how origin_principal_kind/origin_principal_id shipped with
// zero immutability coverage.
//
// So: DISCOVER every migration that (re)defines the function, in localeCompare
// (= apply) order, and treat the LAST one as the effective definition. A future
// migration that extends the deny-list is picked up automatically.
const MIGRATIONS_DIR = join(__dirname, '../../migrations');
const TRIGGER_FUNCTION_NAME = 'action_intents_block_content_update';

const CREATE_TRIGGER_FUNCTION_RE = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${TRIGGER_FUNCTION_NAME}`,
  'i',
);

/** Drops `--` comment lines so prose about the trigger is never mistaken for a definition. */
function stripSqlComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const TRIGGER_MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
  .sort((a, b) => a.localeCompare(b))
  .filter((filename) =>
    CREATE_TRIGGER_FUNCTION_RE.test(
      stripSqlComments(readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')),
    ),
  );

const EFFECTIVE_TRIGGER_MIGRATION = TRIGGER_MIGRATION_FILES[TRIGGER_MIGRATION_FILES.length - 1]!;

/**
 * Slices out the body of a `action_intents_block_content_update()` definition,
 * from the CREATE ... FUNCTION header up to the RAISE EXCEPTION that ends the
 * guard condition. Deliberately anchored on the RAISE rather than the
 * `$$ LANGUAGE plpgsql;` terminator: the original 2026-07-18 definition ends
 * `END $$ LANGUAGE plpgsql;` and the later ones end `END;\n$$ LANGUAGE plpgsql;`,
 * so the RAISE is the only marker common to every version.
 */
function extractTriggerGuard(source: string): string {
  const start = source.search(CREATE_TRIGGER_FUNCTION_RE);
  const end = source.indexOf("RAISE EXCEPTION 'action_intents content is immutable'", start);
  if (start < 0 || end < 0) {
    throw new Error(
      `could not locate the ${TRIGGER_FUNCTION_NAME}() guard body — the definition's shape changed, ` +
        'update extractTriggerGuard() rather than deleting the drift gate it feeds',
    );
  }
  return source.slice(start, end);
}

/**
 * The set of columns the trigger actually guards, parsed out of a definition
 * body. This is what makes the suite drift-proof: the expected list below is
 * asserted EQUAL to this, so the next column added to the trigger fails this
 * test instead of silently going untested.
 */
function parseDenyListedColumns(guardBody: string): string[] {
  const matches = guardBody.matchAll(/NEW\.(\w+)\s+IS\s+DISTINCT\s+FROM\s+OLD\.\1\b/gi);
  return [...matches].map((match) => match[1]!.toLowerCase()).sort();
}

const DENY_LISTED_COLUMNS = parseDenyListedColumns(
  extractTriggerGuard(readFileSync(join(MIGRATIONS_DIR, EFFECTIVE_TRIGGER_MIGRATION), 'utf8')),
);

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

  // Live-DB behavioral coverage for the immutability trigger (Finding 1).
  // Runs only when a real database is reachable (DATABASE_URL set) — e.g.
  // under vitest.integration.config.ts, or a manual local run against the
  // docker-compose test Postgres. Under the plain unit runner (no
  // DATABASE_URL) these are skipped, leaving the static trigger-body checks
  // above as the fallback coverage.
  describe.runIf(!!process.env.DATABASE_URL)('immutability trigger (live DB)', () => {
    let intentId: string;

    beforeAll(async () => {
      const sfx = randomUUID().slice(0, 8);
      await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({ name: `Intent Test Partner ${sfx}`, slug: `intent-test-${sfx}` })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({ partnerId: partner!.id, name: 'Intent Test Org', slug: `intent-test-org-${sfx}` })
          .returning({ id: organizations.id });
        const [user] = await db
          .insert(users)
          .values({
            partnerId: partner!.id,
            orgId: org!.id,
            email: `intent-test-${sfx}@example.com`,
            name: 'Intent Test User',
            status: 'active',
          })
          .returning({ id: users.id });

        const values: NewActionIntent = {
          orgId: org!.id,
          partnerId: partner!.id,
          requestedByUserId: user!.id,
          source: 'chat',
          actionName: 'm365.mailbox.disable',
          actionVersion: 1,
          arguments: { mailbox: 'user@example.com' },
          argumentDigest: 'a'.repeat(64),
          targetSummary: 'Disable mailbox user@example.com',
          impactSummary: 'User loses mailbox access immediately',
          reason: 'Offboarding',
          riskTier: 3,
          connectionId: randomUUID(),
          tenantId: randomUUID(),
          idempotencyKey: `idem-${sfx}`,
          correlationId: randomUUID(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        const [intent] = await db.insert(actionIntents).values(values).returning({
          id: actionIntents.id,
        });
        intentId = intent!.id;
      });
    });

    // One rejecting UPDATE per deny-listed column. Keyed by DB column name so
    // the keys can be asserted equal to the parsed deny-list — that assertion
    // (below) is what forces the NEXT column added to the trigger to arrive
    // with a behavioral test rather than only a static one.
    //
    // Every value here also violates a CHECK/FK (or would, for org_id and the
    // actor columns). That is fine and deliberate: action_intents_immutable_trg
    // is a BEFORE UPDATE ... FOR EACH ROW trigger, and BEFORE-row triggers run
    // ahead of CHECK and referential-integrity evaluation, so the immutability
    // RAISE is always the error that surfaces. If one of these ever reports an
    // FK/CHECK message instead, the trigger stopped firing — which is exactly
    // the failure this suite exists to catch.
    const CONTENT_COLUMN_UPDATES: Record<string, Partial<NewActionIntent>> = {
      org_id: { orgId: randomUUID() },
      requested_by_user_id: { requestedByUserId: randomUUID() },
      requesting_api_key_id: { requestingApiKeyId: randomUUID() },
      source: { source: 'mcp_api' },
      origin_principal_kind: { originPrincipalKind: 'api_key' },
      origin_principal_id: { originPrincipalId: `key-${randomUUID().slice(0, 8)}` },
      action_name: { actionName: 'm365.mailbox.enable' },
      action_version: { actionVersion: 2 },
      arguments: { arguments: { mailbox: 'someone-else@example.com' } },
      argument_digest: { argumentDigest: 'b'.repeat(64) },
      target_summary: { targetSummary: 'Disable mailbox someone-else@example.com' },
      impact_summary: { impactSummary: 'A different user loses access' },
      reason: { reason: 'Changed reason' },
      risk_tier: { riskTier: 2 },
      connection_id: { connectionId: randomUUID() },
      tenant_id: { tenantId: randomUUID() },
      idempotency_key: { idempotencyKey: `idem-changed-${randomUUID().slice(0, 8)}` },
      correlation_id: { correlationId: randomUUID() },
      created_at: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      expires_at: { expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) },
      approval_scope: { approvalScope: 'supervised' },
      classification_version: { classificationVersion: 99 },
      effect_digest: { effectDigest: 'c'.repeat(64) },
    };

    it('has a behavioral case for every column on the trigger deny-list', () => {
      expect(Object.keys(CONTENT_COLUMN_UPDATES).sort()).toEqual(DENY_LISTED_COLUMNS);
    });

    it('the live function body matches the migration this suite parsed', async () => {
      // Belt-and-braces on the drift gate: the static list is derived from the
      // migration FILE, this checks the function actually installed in the
      // database agrees. Catches a DB whose migration ledger is behind, and a
      // hand-patched function in a long-lived environment.
      const [fn] = await withSystemDbAccessContext(() =>
        db.execute<{ prosrc: string }>(sqlTag`
          SELECT p.prosrc AS prosrc
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ${TRIGGER_FUNCTION_NAME}
        `),
      );
      expect(fn?.prosrc, 'immutability trigger function missing from the database').toBeDefined();
      expect(parseDenyListedColumns(fn!.prosrc)).toEqual(DENY_LISTED_COLUMNS);
    });

    it.each(Object.entries(CONTENT_COLUMN_UPDATES) as Array<[string, Partial<NewActionIntent>]>)(
      'rejects an UPDATE that changes the content column %s',
      async (_column, patch) => {
        // Drizzle/postgres-js wraps the underlying Postgres error: the thrown
        // error's own `.message` is a generic "Failed query: ..." summary,
        // and the actual RAISE EXCEPTION text lands on `.cause.message`.
        let caught: unknown;
        try {
          await withSystemDbAccessContext(() =>
            db.update(actionIntents).set(patch).where(eq(actionIntents.id, intentId)),
          );
        } catch (err) {
          caught = err;
        }
        expect(caught, 'expected the immutability trigger to reject the UPDATE').toBeDefined();
        const cause = (caught as { cause?: unknown })?.cause;
        const causeMessage = cause instanceof Error ? cause.message : undefined;
        const topMessage = caught instanceof Error ? caught.message : String(caught);
        expect(causeMessage ?? topMessage).toMatch(/action_intents content is immutable/);
      },
    );

    it('allows an UPDATE to a lifecycle column (status) to succeed', async () => {
      await withSystemDbAccessContext(() =>
        db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, intentId)),
      );
      const [row] = await withSystemDbAccessContext(() =>
        db.select({ status: actionIntents.status }).from(actionIntents).where(eq(actionIntents.id, intentId)),
      );
      expect(row?.status).toBe('approved');
    });

    // The mirror image of the deny-list cases, and the reason they matter:
    // release_by MUST be writable after creation or the approve fan-in
    // (routes/approvals.ts, stamping the RELEASE_LEASE_MS lease in the same
    // CAS that flips the intent to approved) throws at runtime, and the
    // release worker's COALESCE(release_by, expires_at) claim never gets a
    // fresh lease. Without this test, adding release_by to the trigger
    // deny-list would break production with a green suite.
    it('allows an UPDATE to release_by (the decide-path lease stamp)', async () => {
      const lease = new Date(Date.now() + 10 * 60 * 1000);
      await withSystemDbAccessContext(() =>
        db.update(actionIntents).set({ releaseBy: lease }).where(eq(actionIntents.id, intentId)),
      );
      const [row] = await withSystemDbAccessContext(() =>
        db
          .select({ releaseBy: actionIntents.releaseBy })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId)),
      );
      expect(row?.releaseBy?.getTime()).toBe(lease.getTime());
    });

    it('allows an UPDATE to approval_expires_at (the pending-approval deadline)', async () => {
      const deadline = new Date(Date.now() + 30 * 60 * 1000);
      await withSystemDbAccessContext(() =>
        db
          .update(actionIntents)
          .set({ approvalExpiresAt: deadline })
          .where(eq(actionIntents.id, intentId)),
      );
      const [row] = await withSystemDbAccessContext(() =>
        db
          .select({ approvalExpiresAt: actionIntents.approvalExpiresAt })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId)),
      );
      expect(row?.approvalExpiresAt?.getTime()).toBe(deadline.getTime());
    });
  });
});
