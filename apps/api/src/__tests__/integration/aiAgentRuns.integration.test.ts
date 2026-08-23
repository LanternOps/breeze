import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

// Behavioural cover for the ai_agent_runs ledger. The partner-RLS suite covers
// ai_agents; this file covers the org axis, the tenant-scoped dedupe key, and
// the immutability trigger — none of which any other test exercises.

const createdRuns: string[] = [];
const createdAgents: string[] = [];
const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdRuns.length) await db.delete(aiAgentRuns).where(inArray(aiAgentRuns.id, createdRuns));
    if (createdAgents.length) await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
  });
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

/** An org with its own live triage agent. */
async function orgWithAgent() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
      .returning(),
  );
  createdAgents.push(agent!.id);
  return { partner, org, agent: agent! };
}

function runValues(agentId: string, orgId: string, dedupeKey: string) {
  return {
    agentId,
    orgId,
    triggerKind: 'alert' as const,
    dedupeKey,
    modeAtStart: 'shadow' as const,
    policySnapshot: { schemaVersion: 1 } as never,
  };
}

describe('ai_agent_runs — org isolation, dedupe scope, immutability', () => {
  it('rejects a cross-org forge (42501)', async () => {
    const victim = await orgWithAgent();
    const attacker = await orgWithAgent();
    // Attacker's own context, but stamping the victim's org_id on the row.
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(attacker.org.id, attacker.partner.id), () =>
          db.insert(aiAgentRuns).values(runValues(attacker.agent.id, victim.org.id, 'forge-1')).returning(),
        ),
      '42501',
    );
  });

  it('dedupe_key is unique per ORG, not globally', async () => {
    const a = await orgWithAgent();
    const b = await orgWithAgent();
    const SHARED = 'alert:same-key-both-orgs';

    // The same key in two different orgs must both succeed. A global
    // UNIQUE(dedupe_key) would fail the second with 23505 against a row org B
    // cannot see — a cross-tenant existence oracle (see the migration comment).
    for (const t of [a, b]) {
      const [row] = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () =>
        db.insert(aiAgentRuns).values(runValues(t.agent.id, t.org.id, SHARED)).returning(),
      );
      expect(row!.orgId).toBe(t.org.id);
      createdRuns.push(row!.id);
    }

    // ...while a repeat inside ONE org still collides, which is the point of the key.
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(a.org.id, a.partner.id), () =>
          db.insert(aiAgentRuns).values(runValues(a.agent.id, a.org.id, SHARED)).returning(),
        ),
      '23505',
    );
  });

  it('immutability trigger blocks guarded columns but allows lifecycle updates', async () => {
    const t = await orgWithAgent();
    const ctx = orgContext(t.org.id, t.partner.id);
    const [row] = await withDbAccessContext(ctx, () =>
      db.insert(aiAgentRuns).values(runValues(t.agent.id, t.org.id, 'immutable-1')).returning(),
    );
    createdRuns.push(row!.id);

    // Lifecycle columns stay writable.
    const [updated] = await withDbAccessContext(ctx, () =>
      db
        .update(aiAgentRuns)
        .set({ status: 'running', turnCount: 3 })
        .where(inArray(aiAgentRuns.id, [row!.id]))
        .returning(),
    );
    expect(updated!.status).toBe('running');

    // Forensic columns do not.
    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db
            .update(aiAgentRuns)
            .set({ policySnapshot: { schemaVersion: 1, tampered: true } as never })
            .where(inArray(aiAgentRuns.id, [row!.id])),
        ),
      '23000',
    );
    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db
            .update(aiAgentRuns)
            .set({ dedupeKey: 'rewritten' })
            .where(inArray(aiAgentRuns.id, [row!.id])),
        ),
      '23000',
    );
  });

  it('org_id stays re-stampable so moveOrg can re-tenant the ledger', async () => {
    // Regression: org_id was in the immutability guard while the table is in
    // CORE_DEVICE_ORG_DENORMALIZED_TABLES. moveOrg re-stamps org_id in the same
    // transaction that flips devices.org_id, so the guard rolled the whole move
    // back with 23000 and permanently stranded any device an agent had touched.
    const t = await orgWithAgent();
    const target = await createOrganization({ partnerId: t.partner.id });
    const [row] = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () =>
      db.insert(aiAgentRuns).values(runValues(t.agent.id, t.org.id, 'moveorg-1')).returning(),
    );
    createdRuns.push(row!.id);

    // moveOrg runs under a context holding BOTH orgs; RLS WITH CHECK is what
    // fences this, not the trigger.
    const bothOrgs: DbAccessContext = {
      scope: 'organization',
      orgId: t.org.id,
      accessibleOrgIds: [t.org.id, target.id],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: t.partner.id,
    };
    const [moved] = await withDbAccessContext(bothOrgs, () =>
      db.update(aiAgentRuns).set({ orgId: target.id }).where(inArray(aiAgentRuns.id, [row!.id])).returning(),
    );
    expect(moved!.orgId).toBe(target.id);
  });
});
