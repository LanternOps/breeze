import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { AI_AGENT_TRIGGER_KINDS } from '@breeze/shared';
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

  it('org_id is immutable — moveOrg no longer re-tenants the ledger', async () => {
    // Owner decision 2026-08-23 (wave 3b): agent-run history stays with the
    // source org on a device move; moveOrg detaches device lineage instead of
    // re-stamping org_id. With no legitimate org_id writer left, the guard now
    // covers it (2026-09-06-a-agent-runs-org-immutable.sql). This inverts the
    // pre-3b "org_id stays re-stampable" pin; the full move semantics live in
    // agentRunMoveSemantics.integration.test.ts.
    const t = await orgWithAgent();
    const target = await createOrganization({ partnerId: t.partner.id });
    const [row] = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () =>
      db.insert(aiAgentRuns).values(runValues(t.agent.id, t.org.id, 'moveorg-1')).returning(),
    );
    createdRuns.push(row!.id);

    // Even a context holding BOTH orgs (which passes RLS WITH CHECK on the
    // post-image) is stopped by the trigger now.
    const bothOrgs: DbAccessContext = {
      scope: 'organization',
      orgId: t.org.id,
      accessibleOrgIds: [t.org.id, target.id],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: t.partner.id,
    };
    await expectSqlState(
      () =>
        withDbAccessContext(bothOrgs, () =>
          db.update(aiAgentRuns).set({ orgId: target.id }).where(inArray(aiAgentRuns.id, [row!.id])).returning(),
        ),
      '23000',
    );
  });
});

// Contract test for the CHECK constraint that gates `ai_agent_runs.trigger_kind`.
// `ai_agent_runs_trigger_kind_chk` was created inside an `IF NOT EXISTS` guard
// in the shipped 2026-09-02-ai-agents.sql migration, so an existing database
// never automatically picks up a new trigger kind added later — the 'anomaly'
// kind (wave 6 PR 4, #3828) was added to AI_AGENT_TRIGGER_KINDS in shared
// without the migration DROP/ADD that re-syncs the DB-side CHECK, so an insert
// with trigger_kind='anomaly' failed 23514 in the field. This test reads the
// live constraint definition back out of pg_constraint and asserts its value
// set is EXACTLY AI_AGENT_TRIGGER_KINDS (both directions), so the next new
// trigger kind cannot repeat this — a source-scan unit test would not catch a
// migration that forgets to touch the DB-side constraint at all.
describe('ai_agent_runs_trigger_kind_chk — DB constraint matches AI_AGENT_TRIGGER_KINDS', () => {
  it('the constraint value set equals AI_AGENT_TRIGGER_KINDS exactly', async () => {
    const rows = (await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'ai_agent_runs'::regclass
        AND conname = 'ai_agent_runs_trigger_kind_chk';
    `)) as unknown as Array<{ def: string }>;

    expect(rows).toHaveLength(1);
    const def = rows[0]?.def ?? '';
    // e.g. CHECK (trigger_kind = ANY (ARRAY['alert'::text, 'manual'::text, ...]))
    const matches = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
    expect(matches.length).toBeGreaterThan(0);
    const constraintKinds = new Set(matches);
    const sharedKinds = new Set<string>(AI_AGENT_TRIGGER_KINDS);

    // Both directions: nothing in the DB constraint that shared doesn't know
    // about, and nothing in shared that the DB constraint doesn't allow.
    for (const kind of constraintKinds) {
      expect(sharedKinds.has(kind), `DB constraint allows '${kind}' but AI_AGENT_TRIGGER_KINDS does not`).toBe(true);
    }
    for (const kind of sharedKinds) {
      expect(constraintKinds.has(kind), `AI_AGENT_TRIGGER_KINDS has '${kind}' but the DB constraint rejects it`).toBe(
        true,
      );
    }
  });

  it('accepts an insert with trigger_kind=anomaly (regression for #3828 blocker 1)', async () => {
    const t = await orgWithAgent();
    const ctx = orgContext(t.org.id, t.partner.id);
    const [row] = await withDbAccessContext(ctx, () =>
      db
        .insert(aiAgentRuns)
        .values({ ...runValues(t.agent.id, t.org.id, 'anomaly-chk-1'), triggerKind: 'anomaly' })
        .returning(),
    );
    expect(row!.triggerKind).toBe('anomaly');
    createdRuns.push(row!.id);
  });
});
