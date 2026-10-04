/**
 * AI Suggested Fixes W2 — the built-in research agent. One partner baseline
 * row per partner, created the first time research is requested, with honest
 * attribution: created_by NULL + provisioned_by 'system:remediation_research'
 * (ai_agents_creator_chk, migration 2026-12-07-100000). Concurrency: the
 * partial unique index ai_agents_partner_kind_uq (partner_id, kind) WHERE
 * org_id IS NULL AND disabled_at IS NULL makes the insert race-safe; a loser
 * re-reads the winner. A partner that SWITCHED OFF the agent (enabled=false)
 * keeps that row; only a soft-deleted (disabled_at) baseline is re-provisioned.
 *
 * A live partner-level research row that was NOT system-provisioned (a
 * "squatter": created through some path that bypassed the service backstop)
 * is never adopted or mutated — provenance cannot change outside the system
 * scope, and silently trusting a human-authored row as the built-in agent
 * would let it carry arbitrary instructions/allowlist. Fail closed instead.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { RESEARCH_AGENT_NAME, RESEARCH_PROVISIONER } from '@breeze/shared';
import { db } from '../../db';
import { aiAgents } from '../../db/schema/aiAgents';
import { inSystemDbContext } from '../outcomeProbes';

export { assertResearchAgentEdit, ResearchAgentEditError } from './researchAgentEdit';

export class ResearchBaselineConflictError extends Error {
  readonly code = 'research_baseline_not_system_provisioned' as const;
  constructor(readonly partnerId: string) {
    super(`Partner ${partnerId} already has a live partner-level research agent that was not provisioned by the system`);
    this.name = 'ResearchBaselineConflictError';
  }
}

async function readBaseline(partnerId: string): Promise<{ id: string; provisionedBy: string | null } | null> {
  const [row] = await db.select({ id: aiAgents.id, provisionedBy: aiAgents.provisionedBy }).from(aiAgents).where(and(
    eq(aiAgents.partnerId, partnerId), isNull(aiAgents.orgId), eq(aiAgents.kind, 'research'), isNull(aiAgents.disabledAt),
  )).limit(1);
  return row ?? null;
}

function adopt(partnerId: string, row: { id: string; provisionedBy: string | null }): { agentId: string; created: false } {
  if (row.provisionedBy !== RESEARCH_PROVISIONER) throw new ResearchBaselineConflictError(partnerId);
  return { agentId: row.id, created: false };
}

/**
 * Callers must NOT invoke this while holding a request DB transaction:
 * `inSystemDbContext` opens a second pooled connection from inside one, which
 * double-holds the pool (hang at concurrency >= pool size, repo CLAUDE.md /
 * #2417). Call it before entering the request context, or from a self-managed
 * route phase or background path. Its one production caller, requestResearch,
 * asserts that no context is held before calling it.
 */
export async function ensureResearchAgent(partnerId: string): Promise<{ agentId: string; created: boolean }> {
  return inSystemDbContext(async () => {
    const existing = await readBaseline(partnerId);
    if (existing) return adopt(partnerId, existing);
    const [inserted] = await db.insert(aiAgents).values({
      partnerId,
      orgId: null,
      kind: 'research',
      name: RESEARCH_AGENT_NAME,
      enabled: true,
      mode: 'act',
      toolAllowlist: [],
      createdBy: null,
      provisionedBy: RESEARCH_PROVISIONER,
    }).onConflictDoNothing({
      target: [aiAgents.partnerId, aiAgents.kind],
      where: sql`${aiAgents.orgId} IS NULL AND ${aiAgents.disabledAt} IS NULL`,
    }).returning({ id: aiAgents.id });
    if (inserted) return { agentId: inserted.id, created: true };
    const winner = await readBaseline(partnerId);
    if (!winner) throw new Error(`[researchProvisioning] research baseline for partner ${partnerId} vanished after a lost insert race`);
    return adopt(partnerId, winner);
  }, 'researchProvisioning.ensure');
}
