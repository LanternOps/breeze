import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgentCircuits,
  aiAgentFixWatches,
  aiAgentRuns,
  aiAgents,
  devices,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { recordCircuitFailure, CIRCUIT_FAILURE_THRESHOLD } from '../../services/aiAgents/circuitLedger';

/**
 * Wave 6.2a (#3828). Three properties that only a real Postgres can prove, and
 * that the mocked unit suites structurally cannot:
 *
 *  1. Shape-1 RLS actually denies a cross-tenant forge on both new tables.
 *  2. The sweeper's lease claim is EXCLUSIVE under real concurrency — the
 *     `FOR UPDATE SKIP LOCKED` sub-select is the whole mechanism, and a mock
 *     would happily "pass" without it.
 *  3. The circuit's epoch guard actually refuses a stale write, so a human
 *     clearing a breaker mid-check cannot be silently undone.
 */

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdWatches: string[] = [];
const createdCircuits: string[] = [];
const createdRuns: string[] = [];
const createdAgents: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdWatches.length) {
      await db.delete(aiAgentFixWatches).where(inArray(aiAgentFixWatches.id, createdWatches));
    }
    if (createdCircuits.length) {
      await db.delete(aiAgentCircuits).where(inArray(aiAgentCircuits.id, createdCircuits));
    }
    if (createdRuns.length) await db.delete(aiAgentRuns).where(inArray(aiAgentRuns.id, createdRuns));
    if (createdAgents.length) await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
  });
  createdWatches.length = 0;
  createdCircuits.length = 0;
  createdRuns.length = 0;
  createdAgents.length = 0;
});

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

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

/** A tenant with a live agent, a device, and one finished run to hang watches off. */
async function tenantWithRun() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const site = await createSite({ orgId: org.id });

  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [agent] = await db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
      .returning();
    createdAgents.push(agent!.id);

    const unique = randomUUID().slice(0, 8);
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `fixwatch-agent-${unique}`,
        hostname: `fixwatch-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning();

    const [run] = await db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        deviceId: device!.id,
        triggerKind: 'alert' as const,
        dedupeKey: `fixwatch-${unique}`,
        modeAtStart: 'act' as const,
        policySnapshot: { schemaVersion: 1 } as never,
        status: 'completed' as const,
      })
      .returning();
    createdRuns.push(run!.id);

    return { partner, org, agent: agent!, device: device!, run: run! };
  });
}

function watchValues(t: Awaited<ReturnType<typeof tenantWithRun>>, over: Record<string, unknown> = {}) {
  return {
    orgId: t.org.id,
    deviceId: t.device.id,
    agentId: t.agent.id,
    runId: t.run.id,
    watchKind: 'postcondition' as const,
    contractVersion: 1,
    opKey: 'manage_services.restart',
    targetFingerprint: 'service:spooler',
    verifySpecKind: 'service_running',
    target: { kind: 'service', serviceName: 'Spooler' },
    baselineAt: new Date(Date.now() - 60 * 60 * 1000),
    dueAt: new Date(Date.now() - 60 * 1000),
    ...over,
  };
}

describe('ai_agent_fix_watches / ai_agent_circuits — tenant isolation', () => {
  it('rejects a cross-org fix-watch forge (42501)', async () => {
    const victim = await tenantWithRun();
    const attacker = await tenantWithRun();

    await expectSqlState(
      () => withDbAccessContext(orgContext(attacker.org.id, attacker.partner.id), () =>
        db.insert(aiAgentFixWatches)
          .values(watchValues(victim))
          .returning()),
      '42501',
    );
  });

  it('rejects a cross-org circuit forge (42501)', async () => {
    const victim = await tenantWithRun();
    const attacker = await tenantWithRun();

    await expectSqlState(
      () => withDbAccessContext(orgContext(attacker.org.id, attacker.partner.id), () =>
        db.insert(aiAgentCircuits)
          .values({
            orgId: victim.org.id,
            deviceId: victim.device.id,
            agentId: victim.agent.id,
            opKey: 'manage_services.restart',
            targetFingerprint: 'service:spooler',
          })
          .returning()),
      '42501',
    );
  });

  it('does not leak another org’s watches into an org-scoped read', async () => {
    const a = await tenantWithRun();
    const b = await tenantWithRun();
    const [watch] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiAgentFixWatches).values(watchValues(a)).returning());
    createdWatches.push(watch!.id);

    const visible = await withDbAccessContext(orgContext(b.org.id, b.partner.id), () =>
      db.select({ id: aiAgentFixWatches.id }).from(aiAgentFixWatches));

    expect(visible.map((r) => r.id)).not.toContain(watch!.id);
  });

  it('refuses a watch whose run belongs to a different org (composite FK, 23503)', async () => {
    // The (run_id, org_id) -> ai_agent_runs(id, org_id) composite is what makes
    // cross-tenant run attribution structurally impossible rather than merely
    // discouraged. Written from a SYSTEM context so RLS is not what refuses it.
    const a = await tenantWithRun();
    const b = await tenantWithRun();

    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(aiAgentFixWatches)
          .values({ ...watchValues(a), runId: b.run.id })
          .returning()),
      '23503',
    );
  });
});

describe('fix-watch lease claim — exclusivity under concurrency', () => {
  it('never hands the same due watch to two concurrent sweepers', async () => {
    const t = await tenantWithRun();
    const [watch] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiAgentFixWatches).values(watchValues(t)).returning());
    createdWatches.push(watch!.id);

    const { sweepDueFixWatches } = await import('../../services/aiAgents/fixWatchSweeper');

    // Both sweeps race for the one due row. Without FOR UPDATE SKIP LOCKED in
    // the claim's sub-select, both would claim it and the device would be read
    // twice for one watch.
    const [first, second] = await Promise.all([
      sweepDueFixWatches(),
      sweepDueFixWatches(),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
  });

  it('reclaims a watch whose worker died holding an expired lease', async () => {
    const t = await tenantWithRun();
    const [watch] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiAgentFixWatches).values(watchValues(t, {
        // Exactly the state a SIGKILLed worker leaves behind.
        status: 'checking',
        leaseExpiresAt: new Date(Date.now() - 60 * 1000),
      })).returning());
    createdWatches.push(watch!.id);

    const { sweepDueFixWatches } = await import('../../services/aiAgents/fixWatchSweeper');
    const result = await sweepDueFixWatches();

    expect(result.claimed).toBe(1);
  });

  it('leaves a watch whose lease is still live alone', async () => {
    const t = await tenantWithRun();
    const [watch] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiAgentFixWatches).values(watchValues(t, {
        status: 'checking',
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })).returning());
    createdWatches.push(watch!.id);

    const { sweepDueFixWatches } = await import('../../services/aiAgents/fixWatchSweeper');
    const result = await sweepDueFixWatches();

    expect(result.claimed).toBe(0);
  });
});

describe('circuit ledger — threshold and the epoch guard', () => {
  async function key(t: Awaited<ReturnType<typeof tenantWithRun>>) {
    return {
      orgId: t.org.id,
      agentId: t.agent.id,
      deviceId: t.device.id,
      opKey: 'manage_services.restart',
      targetFingerprint: 'service:spooler',
    };
  }

  async function trackCircuit(orgId: string) {
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: aiAgentCircuits.id }).from(aiAgentCircuits).where(eq(aiAgentCircuits.orgId, orgId)));
    for (const r of rows) createdCircuits.push(r.id);
  }

  it('opens exactly once, on the failure that crosses the threshold', async () => {
    const t = await tenantWithRun();
    const k = await key(t);

    const results = [];
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      results.push(await recordCircuitFailure({
        ...k, source: 'fix_regressed', reason: `failure ${i + 1}`,
      }));
    }
    await trackCircuit(t.org.id);

    expect(results.filter((r) => r.opened)).toHaveLength(1);
    expect(results[results.length - 1]!.opened).toBe(true);
    expect(results[results.length - 1]!.state).toBe('open');
  });

  it('refuses a stale write whose epoch was superseded by a manual reset', async () => {
    const t = await tenantWithRun();
    const k = await key(t);

    // One real failure creates the row at epoch 0.
    await recordCircuitFailure({ ...k, source: 'verify_failed', reason: 'first' });
    await trackCircuit(t.org.id);

    // A human clears the breaker while a check is in flight.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(aiAgentCircuits)
        .set({ epoch: 1, failureCount: 0, state: 'closed', resetAt: new Date() })
        .where(eq(aiAgentCircuits.orgId, t.org.id)));

    // The in-flight result lands, still carrying the epoch it captured.
    const stale = await recordCircuitFailure({
      ...k, source: 'fix_regressed', reason: 'stale result', expectedEpoch: 0,
    });

    expect(stale.applied).toBe(false);
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ failureCount: aiAgentCircuits.failureCount })
        .from(aiAgentCircuits)
        .where(eq(aiAgentCircuits.orgId, t.org.id)));
    expect(row!.failureCount).toBe(0);
  });

  it('applies a write whose epoch still holds', async () => {
    const t = await tenantWithRun();
    const k = await key(t);

    await recordCircuitFailure({ ...k, source: 'verify_failed', reason: 'first' });
    await trackCircuit(t.org.id);

    const fresh = await recordCircuitFailure({
      ...k, source: 'fix_regressed', reason: 'second', expectedEpoch: 0,
    });

    expect(fresh.applied).toBe(true);
    expect(fresh.failureCount).toBe(2);
  });
});
