/**
 * Live-Postgres behavioral coverage for `action_intents_block_content_update()`
 * — the BEFORE UPDATE trigger that makes an intent's content immutable once
 * created.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `src/db/migration-action-intents.test.ts`
 * ---------------------------------------------------------------------------
 * These cases used to live inside that unit suite behind
 * `describe.runIf(!!process.env.DATABASE_URL)`. They never ran in CI:
 *
 *   - the blocking `test-api` job has no Postgres service and no DATABASE_URL,
 *     so every case skipped; and
 *   - `migration-action-intents.test.ts` was not in
 *     `vitest.integration.config.ts`'s include list, so the integration job
 *     never picked it up either.
 *
 * Net: `approval_scope`'s immutability — which IS the security value of the
 * column, because an editable scope would let an intent switch approval
 * classification after approvers had already acted on the original one — was
 * asserted nowhere that executes. Same failure mode the sibling suite's header
 * calls out for `origin_principal_kind` / `origin_principal_id`.
 *
 * Living under `src/__tests__/integration/` is what fixes that, and it is the
 * repo's established home for "prove this migration's DDL actually behaves"
 * suites (`ringThirdPartyBackfillMigration.integration.test.ts`,
 * `refreshTokenStorageHardeningMigration.integration.test.ts`, …). That
 * directory is matched wholesale by BOTH configs — `vitest.integration.config.ts`'s
 * `src/__tests__/integration/**\/*.test.ts` include AND `vitest.config.ts`'s
 * `src/__tests__/integration/**` exclude — so the file runs in the blocking
 * `integration-test` job and contributes zero skips to the unit runner, with no
 * per-file hand-listing needed in either config.
 *
 * FIXTURES ARE PER-TEST, NOT PER-FILE. The shared integration setup
 * (`./setup`) TRUNCATEs the core tenant tables in a global `beforeEach`, and
 * `action_intents.org_id` REFERENCES organizations(id), so anything seeded in a
 * `beforeAll` is CASCADE-deleted before the second test in the file. Seeding in
 * `beforeEach` is what makes the suite truncation-safe; it is also why every
 * case gets a genuinely fresh `pending_approval` intent rather than inheriting
 * whatever the previous case left behind.
 *
 * The deny-list itself is DISCOVERED from the migrations (see
 * `src/testUtils/actionIntentsTriggerDenyList.ts`), and this suite asserts it
 * has one behavioral case per column — so the next column added to the trigger
 * arrives with a real rejecting-UPDATE test or fails right here.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql as sqlTag } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users, actionIntents } from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import {
  DENY_LISTED_COLUMNS,
  TRIGGER_FUNCTION_NAME,
  parseDenyListedColumns,
} from '../../testUtils/actionIntentsTriggerDenyList';

/**
 * Seeds partner -> org -> user -> a `pending_approval` action_intent and
 * returns the intent id. Called from `beforeEach` (see the header note on the
 * shared TRUNCATE hook).
 */
async function seedPendingIntent(): Promise<string> {
  const sfx = randomUUID().slice(0, 8);
  return withSystemDbAccessContext(async () => {
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
    return intent!.id;
  });
}

describe('action_intents immutability trigger (live DB)', () => {
  let intentId: string;

  beforeEach(async () => {
    intentId = await seedPendingIntent();
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
