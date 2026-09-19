/**
 * AI Operator polled/list read paths — RLS index promotability contract
 * (#5205 W03, #5208; spec §11.1).
 *
 * What only a real Postgres, as the unprivileged `breeze_app` role, can prove:
 * under FORCE ROW LEVEL SECURITY the planner promotes a clause to an index
 * condition only when it is leakproof. That is the whole reason every state,
 * phase and outcome column on these tables is `text` + CHECK rather than a
 * `pgEnum` — enum equality is NOT leakproof, so a `state = 'waiting'::state_enum`
 * predicate could not become an index condition and the coordinator's 15-second
 * tick would degrade to a full scan of every task in the deployment. That is
 * exactly the shape of the 2026-09-03 US incident (audit_logs device feed,
 * 2.4M rows, 13-minute queries, connection-slot exhaustion), one table earlier.
 *
 * With `enable_seqscan = off`, any usable index beats a seq scan by ~1e10 cost,
 * so a Seq Scan surviving in the plan means the clause is NOT promotable under
 * RLS — which is the regression this guards. A plan captured as `doadmin` (or
 * any BYPASSRLS role) proves nothing, hence `withDbAccessContext` around every
 * EXPLAIN.
 *
 * Partial-index predicates are asserted as LITERALS in the query text on
 * purpose. A Drizzle `sql` template inlines a literal, but an interpolated
 * `${value}` or an `eq()` binds a parameter the predicate proof cannot see, so
 * the same query written "properly" would silently stop using the partial
 * index. Do not "clean these up" into bound parameters.
 *
 * Pattern follows deviceEventsFeedIndexes.integration.test.ts. That file (and
 * agentRunMoveSemantics.integration.test.ts) is owned by wave W02, which is
 * extracting a shared EXPLAIN harness in parallel — this suite deliberately
 * carries its own copy rather than editing either, and should adopt the shared
 * helper once W02 lands.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};

function planText(rows: unknown[]): string {
  return rows.map((r) => Object.values(r as Record<string, unknown>).join(' ')).join('\n');
}

describe('AI Operator polled read paths — partial indexes are usable under RLS (breeze_app)', () => {
  let orgId: string;
  let otherOrgId: string;

  // beforeEach, not beforeAll: the shared harness TRUNCATEs core tenant tables
  // on every test, and everything here hangs off organizations.
  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const other = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    orgId = org.id;
    otherOrgId = other.id;

    const agentIdByOrg = new Map<string, string>();
    for (const o of [org.id, other.id]) {
      const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(aiAgents)
          .values({ orgId: o, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
          .returning(),
      );
      agentIdByOrg.set(o, agent!.id);
    }

    // Skew that makes the planner's choice meaningful rather than a coin toss
    // on a tiny table: ~1,200 tasks across two orgs, of which only 20 are
    // `waiting` with a due wake, and ~400 are `running` in the org under test.
    // Production is far more skewed still — one `waiting` row per thousand.
    const adminDb = getTestDb() as never as typeof db;
    const values: string[] = [];
    const push = (o: string, state: string, wakeOffsetSeconds: number | null) => {
      values.push(
        `('${o}', '${agentIdByOrg.get(o)}', 'triage', 'Triage', 'service_recovery', 1, 'manual', ` +
          `'restart the print spooler', '${state}', ` +
          `${wakeOffsetSeconds === null ? 'NULL' : `now() - interval '${wakeOffsetSeconds} seconds'`}, ` +
          `now() - interval '${Math.floor(Math.random() * 10_000)} seconds')`,
      );
    };
    for (let i = 0; i < 400; i++) push(orgId, 'running', null);
    for (let i = 0; i < 380; i++) push(orgId, 'completed', null);
    for (let i = 0; i < 400; i++) push(otherOrgId, 'completed', null);
    for (let i = 0; i < 10; i++) push(orgId, 'waiting', 30);
    for (let i = 0; i < 10; i++) push(otherOrgId, 'waiting', 30);

    await adminDb.execute(
      sql.raw(`
        INSERT INTO ai_operator_tasks
          (org_id, agent_id, agent_kind, agent_name, workflow_key, workflow_version,
           origin_kind, objective, state, next_wake_at, updated_at)
        VALUES ${values.join(',')}`),
    );

    // Outbox: one due unpublished row per org against ~1,000 published ones.
    await adminDb.execute(sql`
      INSERT INTO ai_operator_task_outbox (org_id, task_id, source_kind, source_id, transition_seq, due_at, published_at)
      SELECT t.org_id, t.id, 'intent', gen_random_uuid()::text, 1,
             now() - interval '10 seconds',
             CASE WHEN t.state = 'waiting' THEN NULL ELSE now() END
        FROM ai_operator_tasks t`);

    await adminDb.execute(sql`ANALYZE ai_operator_tasks`);
    await adminDb.execute(sql`ANALYZE ai_operator_task_outbox`);
  });

  function inContext<T>(ctx: DbAccessContext, fn: () => Promise<T>): Promise<T> {
    return withDbAccessContext(ctx, fn);
  }

  async function explain(ctx: DbAccessContext, query: ReturnType<typeof sql>): Promise<string> {
    return inContext(ctx, async () => {
      await db.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = await db.execute(sql`EXPLAIN ${query}`);
      return planText(Array.from(rows as Iterable<unknown>));
    });
  }

  it('coordinator wake poll uses ai_operator_tasks_wake_idx, not a scan of every task', async () => {
    // The coordinator runs system-scoped: it must find due tasks across every
    // tenant, so there is no org predicate to fall back on. If `state` were a
    // pgEnum this is the query that would degrade to a full table scan.
    const plan = await explain(
      SYSTEM_CTX,
      sql`SELECT id FROM ai_operator_tasks
           WHERE state = 'waiting' AND next_wake_at <= now()
           ORDER BY next_wake_at
           LIMIT 50`,
    );
    expect(plan).toContain('ai_operator_tasks_wake_idx');
    expect(plan).not.toContain('Seq Scan on ai_operator_tasks');
  });

  it('lease-reclaim scan uses ai_operator_tasks_lease_idx', async () => {
    const plan = await explain(
      SYSTEM_CTX,
      sql`SELECT id FROM ai_operator_tasks
           WHERE state IN ('running', 'stopping') AND lease_expires_at < now()
           ORDER BY lease_expires_at
           LIMIT 50`,
    );
    expect(plan).toContain('ai_operator_tasks_lease_idx');
    expect(plan).not.toContain('Seq Scan on ai_operator_tasks');
  });

  it('outbox publisher poll uses ai_operator_task_outbox_unpublished_idx', async () => {
    const plan = await explain(
      SYSTEM_CTX,
      sql`SELECT id FROM ai_operator_task_outbox
           WHERE published_at IS NULL AND due_at <= now()
           ORDER BY due_at, id
           LIMIT 50`,
    );
    expect(plan).toContain('ai_operator_task_outbox_unpublished_idx');
    expect(plan).not.toContain('Seq Scan on ai_operator_task_outbox');
  });

  it('workspace list uses ai_operator_tasks_org_state_updated_idx under an ORG-scoped context', async () => {
    // Org scope, not system: this is the tenant-facing read, and it is the one
    // whose plan an org token actually gets. `org_id` here IS a bound
    // parameter — that is correct, it is an equality on an indexed leakproof
    // column, not a partial-index predicate.
    const plan = await explain(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [] },
      sql`SELECT id FROM ai_operator_tasks
           WHERE org_id = ${orgId}::uuid AND state = 'running'
           ORDER BY updated_at DESC
           LIMIT 25`,
    );
    expect(plan).toContain('ai_operator_tasks_org_state_updated_idx');
    expect(plan).not.toContain('Seq Scan on ai_operator_tasks');
  });

  it('device-page task feed uses ai_operator_tasks_device_idx', async () => {
    const deviceId = randomUUID();
    const plan = await explain(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [] },
      sql`SELECT id FROM ai_operator_tasks
           WHERE device_id = ${deviceId}::uuid
           ORDER BY created_at DESC
           LIMIT 25`,
    );
    expect(plan).toContain('ai_operator_tasks_device_idx');
    expect(plan).not.toContain('Seq Scan on ai_operator_tasks');
  });

  it('reconciler operation scan uses ai_operator_operations_org_task_result_idx', async () => {
    const adminDb = getTestDb() as never as typeof db;
    await adminDb.execute(sql`
      INSERT INTO ai_operator_operations (org_id, task_id, task_step_key, operation_key, argument_digest, result_state)
      SELECT t.org_id, t.id, 'restart', 'restart:spooler:1', repeat('a', 64),
             CASE WHEN t.state = 'waiting' THEN 'pending' ELSE 'succeeded' END
        FROM ai_operator_tasks t`);
    await adminDb.execute(sql`ANALYZE ai_operator_operations`);

    const taskId = (
      (await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`SELECT id FROM ai_operator_tasks WHERE state = 'waiting' LIMIT 1`),
      )) as unknown as Array<{ id: string }>
    )[0]!.id;

    const plan = await explain(
      SYSTEM_CTX,
      sql`SELECT id FROM ai_operator_operations
           WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid AND result_state = 'pending'`,
    );
    expect(plan).toContain('ai_operator_operations_org_task_result_idx');
    expect(plan).not.toContain('Seq Scan on ai_operator_operations');
  });
});
