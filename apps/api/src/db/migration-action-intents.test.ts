import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from './index';
import { partners, organizations, users, actionIntents } from './schema';
import type { NewActionIntent } from './schema/actionIntents';

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

  // The 12 spec-defined immutable content columns (§3.1/§3.4). Kept as a
  // single source of truth for both the static trigger-body check below and
  // the live-DB behavioral suite.
  const IMMUTABLE_CONTENT_COLUMNS = [
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
  ] as const;

  it('declares the immutability trigger over exactly the content columns', () => {
    expect(sql).toMatch(/action_intents_block_content_update/);
    expect(sql).toMatch(/action_intents_immutable_trg/);
    expect(sql).toMatch(/RAISE EXCEPTION 'action_intents content is immutable'/);
    const triggerBody = sql.slice(
      sql.indexOf('action_intents_block_content_update() RETURNS trigger'),
      sql.indexOf('END $$ LANGUAGE plpgsql;'),
    );
    // Every one of the 12 spec'd immutable content columns must be guarded.
    for (const contentCol of IMMUTABLE_CONTENT_COLUMNS) {
      expect(
        triggerBody,
        `expected trigger body to guard content column ${contentCol}`,
      ).toMatch(new RegExp(`NEW\\.${contentCol}\\b`));
    }
    // Lifecycle columns must NOT appear in the immutability check.
    for (const lifecycleCol of ['status', 'decided_at', 'executed_at', 'result', 'error_code']) {
      expect(triggerBody).not.toMatch(new RegExp(`NEW\\.${lifecycleCol}\\b`));
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

  it('forces RLS on intent_outbox with no permissive policies (system-scoped)', () => {
    expect(sql).toMatch(/ALTER TABLE intent_outbox ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE intent_outbox FORCE ROW LEVEL SECURITY/);
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

    const contentColumnUpdates: Array<[string, Partial<NewActionIntent>]> = [
      ['action_name', { actionName: 'm365.mailbox.enable' }],
      ['action_version', { actionVersion: 2 }],
      ['arguments', { arguments: { mailbox: 'someone-else@example.com' } }],
      ['argument_digest', { argumentDigest: 'b'.repeat(64) }],
      ['target_summary', { targetSummary: 'Disable mailbox someone-else@example.com' }],
      ['impact_summary', { impactSummary: 'A different user loses access' }],
      ['reason', { reason: 'Changed reason' }],
      ['risk_tier', { riskTier: 2 }],
      ['connection_id', { connectionId: randomUUID() }],
      ['tenant_id', { tenantId: randomUUID() }],
      ['idempotency_key', { idempotencyKey: `idem-changed-${randomUUID().slice(0, 8)}` }],
      ['correlation_id', { correlationId: randomUUID() }],
    ];

    it.each(contentColumnUpdates)(
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
  });
});
