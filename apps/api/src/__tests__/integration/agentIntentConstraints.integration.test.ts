/**
 * Live-Postgres proof for the agent-originated `action_intents` constraints
 * added by `migrations/2026-09-05-a-agent-originated-intents.sql` (AI agents
 * wave 3, #3824, task 5). Unit tests cannot cover any of this: every
 * invariant here lives in a CHECK constraint, a composite FK, or the
 * immutability trigger, none of which a mocked Drizzle client evaluates.
 *
 * Every insert below goes through `db.insert(actionIntents).values(...)` (the
 * real Drizzle model), not raw SQL. `pnpm db:check-drift` does not compare
 * the Drizzle schema to the database (see `scripts/check-drift.ts:16-26`), so
 * this suite is the only automated thing that would catch a mis-modelled
 * column, a transposed composite-FK column pair, or a stray single-column
 * `.references()` on `requestingAgentRunId`.
 *
 * Fixtures are seeded fresh in `beforeEach` (not `beforeAll`): the shared
 * integration setup (`./setup`) TRUNCATEs the core tenant tables in a global
 * `beforeEach`, and both `action_intents.org_id` and `ai_agent_runs.org_id`
 * reference `organizations(id)`, so anything seeded in `beforeAll` would be
 * cascade-deleted before the second test runs (same trap documented in
 * `actionIntentsImmutabilityTrigger.integration.test.ts`).
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents, aiAgents, aiAgentRuns, auditLogs } from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import { createOrganization, createPartner, createUser, reapplyOrgIdFkDeferrability } from './db-utils';

describe('agent-originated action_intents constraints', () => {
  let orgId: string;
  let otherOrgId: string;
  let partnerId: string;
  let userId: string;
  let agentId: string;
  let runId: string;
  let otherRunId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    // Two orgs under the SAME partner: the cross-tenant FK case needs a
    // second org to point an intent at while the run stays under the first.
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });

    partnerId = partner.id;
    orgId = org.id;
    otherOrgId = otherOrg.id;
    userId = user.id;

    await withSystemDbAccessContext(async () => {
      const [agent] = await db
        .insert(aiAgents)
        .values({ orgId, partnerId: null, kind: 'triage', name: 'Triage', createdBy: userId })
        .returning();
      agentId = agent!.id;

      const [run] = await db
        .insert(aiAgentRuns)
        .values({
          agentId,
          orgId,
          triggerKind: 'alert',
          dedupeKey: `agent-intent-constraints-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
        })
        .returning();
      runId = run!.id;

      // A second live run under the SAME org, used only as the "swap to"
      // target for the immutability case — never inserted onto an intent.
      const [run2] = await db
        .insert(aiAgentRuns)
        .values({
          agentId,
          orgId,
          triggerKind: 'alert',
          dedupeKey: `agent-intent-constraints-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
        })
        .returning();
      otherRunId = run2!.id;
    });
  });

  /** Inserts an action_intents row with sane defaults for every NOT NULL column, via the real Drizzle model. */
  async function insertIntent(overrides: Partial<NewActionIntent>): Promise<string> {
    const sfx = randomUUID().slice(0, 8);
    const values: NewActionIntent = {
      orgId,
      partnerId,
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: null,
      source: 'chat',
      originPrincipalKind: 'unknown',
      originPrincipalId: null,
      actionName: 'm365.mailbox.disable',
      actionVersion: 1,
      arguments: { mailbox: 'user@example.com' },
      argumentDigest: 'a'.repeat(64),
      targetSummary: 'Disable mailbox user@example.com',
      impactSummary: 'User loses mailbox access immediately',
      reason: 'Offboarding',
      riskTier: 3, // smallint, not the text tier name
      idempotencyKey: `idem-${sfx}`,
      correlationId: randomUUID(), // uuid column, not free text
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    };
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(actionIntents).values(values).returning({ id: actionIntents.id }),
    );
    return row!.id;
  }

  async function deleteRun(id: string): Promise<void> {
    await withSystemDbAccessContext(() => db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, id)));
  }

  async function updateIntentRun(id: string, newRunId: string): Promise<void> {
    await withSystemDbAccessContext(() =>
      db.update(actionIntents).set({ requestingAgentRunId: newRunId }).where(eq(actionIntents.id, id)),
    );
  }

  /**
   * Drizzle/postgres-js wraps the underlying Postgres error in a
   * `DrizzleQueryError` whose own `.code` is undefined — the SQLSTATE lands
   * on `.cause.code` instead (mirrors `aiAgentRuns.integration.test.ts`'s
   * `expectSqlState`). A plain `.rejects.toMatchObject({ code })` against the
   * top-level error silently mismatches, so unwrap `.cause` first.
   */
  async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
    let raised: unknown;
    try {
      await fn();
    } catch (err) {
      raised = err;
    }
    expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
    const cause = (raised as { cause?: { code?: string } })?.cause;
    expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
  }

  it('accepts an intent with a run and no human actor', async () => {
    const id = await insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'ai_agent',
    });
    expect(id).toBeTruthy();
  });

  it('rejects an intent with NO actor at all (23514)', async () => {
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: null,
          requestingApiKeyId: null,
          requestingAgentRunId: null,
          originPrincipalKind: 'unknown',
          source: 'chat',
        }),
      '23514',
    );
  });

  it('rejects an intent with TWO actor roots (23514)', async () => {
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: userId,
          requestingApiKeyId: null,
          requestingAgentRunId: runId,
          originPrincipalKind: 'ai_agent',
          source: 'ai_agent',
        }),
      '23514',
    );
  });

  it('rejects an ai_agent origin with no run (23514)', async () => {
    // The half-formed row action_intents_agent_origin_chk exists to stop:
    // claims an agent origin, carries no run, so release revalidation would
    // have nothing to re-check against.
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: userId,
          requestingApiKeyId: null,
          requestingAgentRunId: null,
          originPrincipalKind: 'ai_agent',
          source: 'ai_agent',
        }),
      '23514',
    );
  });

  it('rejects a run link that does not claim an agent origin (23514)', async () => {
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: null,
          requestingApiKeyId: null,
          requestingAgentRunId: runId,
          originPrincipalKind: 'system',
          source: 'chat',
        }),
      '23514',
    );
  });

  it('rejects an intent whose org differs from its run org (23503)', async () => {
    // The composite FK (requesting_agent_run_id, org_id) -> ai_agent_runs(id, org_id)
    // is what makes agent attribution tenant-safe. A single-column FK would let
    // an intent in org A cite a run in org B, and RLS would not catch it: the
    // action_intents policy checks only action_intents.org_id. Precedent:
    // elevation_audit -> elevation_requests(id, org_id).
    await expectSqlState(
      () =>
        insertIntent({
          orgId: otherOrgId, // run belongs to orgId, not otherOrgId
          requestedByUserId: null,
          requestingApiKeyId: null,
          requestingAgentRunId: runId,
          originPrincipalKind: 'ai_agent',
          originPrincipalId: agentId,
          source: 'ai_agent',
        }),
      '23503',
    );
  });

  it('rejects a source that disagrees with the origin kind (23514)', async () => {
    // source drives notification + expiry; origin_principal_kind drives
    // authorization. A row where they disagree takes one path while claiming
    // the other.
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: null,
          requestingApiKeyId: null,
          requestingAgentRunId: runId,
          originPrincipalKind: 'ai_agent',
          originPrincipalId: agentId,
          source: 'chat',
        }),
      '23514',
    );
  });

  it('refuses to delete a run that an intent still attributes (23503)', async () => {
    await insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'ai_agent',
    });
    await expectSqlState(() => deleteRun(runId), '23503');
  });

  it('treats requesting_agent_run_id as immutable content', async () => {
    const id = await insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'ai_agent',
    });
    let caught: unknown;
    try {
      await updateIntentRun(id, otherRunId);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the immutability trigger to reject the UPDATE').toBeDefined();
    const cause = (caught as { cause?: unknown })?.cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    const topMessage = caught instanceof Error ? caught.message : String(caught);
    expect(causeMessage ?? topMessage).toMatch(/action_intents content is immutable/);
  });

  it('rejects source ai_agent on a HUMAN-origin intent (agent_source_chk, reverse direction, 23514)', async () => {
    // The forward direction (agent origin + source 'chat') is covered above.
    // This row passes one_actor_chk (exactly one actor: the user) and
    // agent_origin_chk (kind!='ai_agent' AND run NULL → false = false), so
    // the ONLY constraint that can reject it is the source↔kind biconditional
    // — a future rewrite of agent_source_chk into a one-way implication would
    // turn this test red.
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: userId,
          requestingApiKeyId: null,
          requestingAgentRunId: null,
          originPrincipalKind: 'user_session',
          originPrincipalId: null,
          source: 'ai_agent',
        }),
      '23514',
    );
  });

  it('audit_logs accepts actor_type ai_agent against the live enum (2026-09-05-b)', async () => {
    // Nothing else exercises the ALTER TYPE migration end-to-end: the audit
    // unit tests mock persistence, and db:check-drift does not compare the
    // Drizzle actorTypeEnum to the database. If the enum value were missing
    // or misspelled, the failure mode in production is a 22P02 inside a
    // fire-and-forget async audit write — every agent audit row silently
    // dropped. This insert-and-read-back through the real Drizzle model is
    // the proof the value exists.
    const [row] = await withSystemDbAccessContext(() =>
      db
        .insert(auditLogs)
        .values({
          orgId,
          actorType: 'ai_agent',
          actorId: agentId,
          action: 'action_intent.created',
          resourceType: 'action_intent',
          result: 'success',
          details: { agentId, agentRunId: runId },
          initiatedBy: 'ai',
        })
        .returning({ id: auditLogs.id, actorType: auditLogs.actorType }),
    );
    expect(row!.actorType).toBe('ai_agent');
  });

  it('re-applying 2026-09-05-a onto a migrated database is a no-op that preserves live rows', async () => {
    // A mid-file failure rolls back autoMigrate's per-file transaction and
    // the WHOLE file re-runs on next boot, so idempotent re-application is a
    // real production path — and this file documents its own re-run hazard
    // (the dependent composite FK must drop before the backing UNIQUE on
    // every run, not only the first). Mirrors
    // refreshTokenStorageHardeningMigration.integration.test.ts.
    const intentId = await insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'ai_agent',
    });

    // getTestDb() is the superuser client — the same shape the
    // refreshTokenStorageHardeningMigration replay test uses for DDL.
    const migrationSql = readFileSync(
      join(__dirname, '../../../migrations/2026-09-05-a-agent-originated-intents.sql'),
      'utf8',
    );
    await getTestDb().execute(sql.raw(migrationSql));
    // The enum-widening sibling is a single ADD VALUE IF NOT EXISTS — cheap
    // to prove idempotent in the same pass.
    const enumMigrationSql = readFileSync(
      join(__dirname, '../../../migrations/2026-09-05-b-audit-actor-type-ai-agent.sql'),
      'utf8',
    );
    await getTestDb().execute(sql.raw(enumMigrationSql));
    // 2026-09-05-a's unconditional DROP+ADD of
    // action_intents_requesting_agent_run_id_org_id_fkey carries no DEFERRABLE
    // clause, so replaying it here undoes the org-lifecycle branch's
    // deferrable-FK contract (migrations/2026-09-12-100001-org-lifecycle-foundations.sql
    // Section 2). Restore it rather than editing the shipped migration.
    await reapplyOrgIdFkDeferrability(getTestDb(), [
      'action_intents_requesting_agent_run_id_org_id_fkey',
    ]);

    // The re-added composite FK validated existing rows; the pre-existing
    // agent intent must have survived, and the constraints must still fire.
    const [intact] = await withSystemDbAccessContext(() =>
      db
        .select({ id: actionIntents.id, runId: actionIntents.requestingAgentRunId })
        .from(actionIntents)
        .where(eq(actionIntents.id, intentId)),
    );
    expect(intact?.runId).toBe(runId);
    await expectSqlState(
      () =>
        insertIntent({
          requestedByUserId: null,
          requestingApiKeyId: null,
          requestingAgentRunId: null,
          originPrincipalKind: 'unknown',
          source: 'chat',
        }),
      '23514',
    );
  });
});
