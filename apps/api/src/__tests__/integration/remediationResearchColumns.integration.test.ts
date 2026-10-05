import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, remediationSuggestions } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };

async function expectSqlState(fn: () => Promise<unknown>, code: string) {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

describe('remediation_suggestions research columns (W2 Task 5)', () => {
  async function seed() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `research-cols-${randomUUID()}@example.com` });
    return withDbAccessContext(SYSTEM, async () => {
      const [agent] = await db.insert(aiAgents)
        .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Research test agent', createdBy: user.id })
        .returning({ id: aiAgents.id });
      const mkRun = async () => {
        const [run] = await db.insert(aiAgentRuns).values({
          agentId: agent!.id, orgId: org.id, triggerKind: 'alert', dedupeKey: `research-cols-${randomUUID()}`,
          modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never,
        }).returning({ id: aiAgentRuns.id });
        return run!.id;
      };
      return { org, runA: await mkRun(), runB: await mkRun() };
    });
  }

  const suggestion = (orgId: string, sourceId: string, agentRunId: string, ordinal: number) => ({
    orgId, sourceType: 'alert', sourceId, targetType: 'builtin_action', builtinAction: 'reboot' as const,
    title: 'Reboot', rationale: 'r', expectedAction: 'e', origin: 'ai_research' as const, agentRunId, researchOrdinal: ordinal,
  });

  it('two research rows for the same source + builtin_action under different runs survive deleting a run', async () => {
    const { org, runA, runB } = await seed();
    const sourceId = randomUUID();
    await withDbAccessContext(SYSTEM, async () => {
      await db.insert(remediationSuggestions).values(suggestion(org.id, sourceId, runA, 0));
      await db.insert(remediationSuggestions).values(suggestion(org.id, sourceId, runB, 0));
      // agent_run_id is ON DELETE SET NULL: the orphaned row must not collide
      // with the other research row through the memory-attach unique index.
      // (org erasure deletes every run). Both orphans must coexist.
      await db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, runA));
      await db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, runB));
      const rows = await db.select({ id: remediationSuggestions.id, runId: remediationSuggestions.agentRunId })
        .from(remediationSuggestions).where(eq(remediationSuggestions.sourceId, sourceId));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.runId === null)).toBe(true);
    });
  });

  it('rejects an unknown target_type with a CHECK violation (23514)', async () => {
    const { org, runA } = await seed();
    await expectSqlState(
      () => withDbAccessContext(SYSTEM, () => db.insert(remediationSuggestions).values({
        ...suggestion(org.id, randomUUID(), runA, 0), targetType: 'bogus_kind',
      })),
      '23514',
    );
  });
});
