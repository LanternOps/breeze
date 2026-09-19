import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema';
import { aiRunWorkspaces } from '../../db/schema/aiWorkspace';
import { createOrganization, createPartner, createUser } from './db-utils';

/**
 * Live-DB proof for ai_run_workspaces (spec §6.2). Five properties:
 *  1. the owning org CAN insert its own row  — the positive control, without
 *     which the 42501 case below could be green for the wrong reason
 *     (a typo'd column, a missing table, a fixture that never ran);
 *  2. an org context CANNOT insert a row for another org (42501);
 *  3. an org context cannot SELECT another org's workspace row;
 *  4. deleting the parent run cascades the workspace row away;
 *  5. at most one LIVE workspace per run (partial unique index).
 *
 * Every write goes through the normal `db` proxy inside an explicit
 * DbAccessContext, exactly as aiAgentsPartnerRls.integration.test.ts does.
 * The forged insert reuses the VICTIM's own (run_id, org_id) pair so the
 * composite FK is satisfiable — if the row were refused with 23503 we would
 * be proving the FK works, not the policy.
 */

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
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

interface Tenant {
  partnerId: string;
  orgId: string;
  runId: string;
}

/** One partner + one org + one ai_agents row + one ai_agent_runs row. */
async function seedTenantWithRun(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });

  const runId = await withSystemDbAccessContext(async () => {
    const [agent] = await db
      .insert(aiAgents)
      .values({
        orgId: org.id,
        partnerId: null,
        kind: 'triage',
        name: 'Workspace fixture',
        createdBy: user.id,
      })
      .returning({ id: aiAgents.id });
    const [run] = await db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        triggerKind: 'manual',
        dedupeKey: `workspace-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
      })
      .returning({ id: aiAgentRuns.id });
    return run!.id as string;
  });

  return { partnerId: partner.id, orgId: org.id, runId };
}

function workspaceValues(t: Tenant, providerRef: string) {
  return {
    orgId: t.orgId,
    runId: t.runId,
    backend: 'fake' as const,
    providerRef,
    region: 'eu' as const,
    deadlineAt: new Date(Date.now() + 3_600_000),
  };
}

afterEach(async () => {
  await withSystemDbAccessContext(() => db.delete(aiRunWorkspaces));
});

describe('ai_run_workspaces RLS', () => {
  it('lets the owning org insert and read its own workspace row (positive control)', async () => {
    const t = await seedTenantWithRun();
    const rows = await withDbAccessContext(orgContext(t.orgId, t.partnerId), () =>
      db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-own')).returning(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(t.orgId);
    expect(rows[0]?.status).toBe('creating');

    const read = await withDbAccessContext(orgContext(t.orgId, t.partnerId), () =>
      db.select().from(aiRunWorkspaces),
    );
    expect(read.map((r) => r.providerRef)).toEqual(['fake-own']);
  });

  it('refuses a forged cross-tenant insert with 42501', async () => {
    const attacker = await seedTenantWithRun();
    const victim = await seedTenantWithRun();
    // The victim's own (run_id, org_id) pair — the composite FK is satisfied,
    // so the ONLY thing that can refuse this row is the policy.
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(attacker.orgId, attacker.partnerId), () =>
          db.insert(aiRunWorkspaces).values(workspaceValues(victim, 'forged')).returning(),
        ),
      '42501',
    );
  });

  it('hides another org’s rows from an org context', async () => {
    const owner = await seedTenantWithRun();
    const other = await seedTenantWithRun();
    await withSystemDbAccessContext(() =>
      db.insert(aiRunWorkspaces).values(workspaceValues(owner, 'fake-owner')),
    );
    const rows = await withDbAccessContext(orgContext(other.orgId, other.partnerId), () =>
      db.select().from(aiRunWorkspaces),
    );
    expect(rows).toEqual([]);
  });

  it('cascades away when the parent run is deleted', async () => {
    const t = await seedTenantWithRun();
    await withSystemDbAccessContext(async () => {
      await db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-cascade'));
      await db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, t.runId));
      expect(await db.select().from(aiRunWorkspaces)).toEqual([]);
    });
  });

  it('allows at most one live workspace per run', async () => {
    const t = await seedTenantWithRun();
    await expectSqlState(
      () =>
        withSystemDbAccessContext(async () => {
          await db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-first'));
          await db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-second'));
        }),
      '23505',
    );
  });
});
