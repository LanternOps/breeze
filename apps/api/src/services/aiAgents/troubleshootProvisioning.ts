/**
 * Wisp delegation W1 (#11084) — the built-in troubleshoot agent. One partner
 * row per partner, created the first time Wisp hands a device off, with honest
 * attribution: created_by NULL + provisioned_by 'system:device_troubleshooting'
 * (ai_agents_creator_chk; only the system scope may write provisioned_by).
 *
 * The row is `mode: 'shadow'` and stores the proposable tool set as its
 * allowlist: intent minting (intentService) and release
 * (agentReleaseAuthority) re-check the STORED row, so an empty allowlist would
 * refuse every proposal the run makes (plan Decision 2). Admission still
 * forces the run itself to shadow whatever this row says.
 *
 * Concurrency: the partial unique index ai_agents_partner_kind_uq (partner_id,
 * kind) WHERE org_id IS NULL AND disabled_at IS NULL makes the insert
 * race-safe; a loser re-reads the winner. A partner that switched the agent
 * off (enabled=false) keeps that row. Only a system-provisioned row is ever
 * adopted — anything else fails closed, same rule as researchProvisioning.ts.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TROUBLESHOOT_AGENT_NAME, TROUBLESHOOT_PROVISIONER } from '@breeze/shared';
import { db } from '../../db';
import { aiAgents } from '../../db/schema/aiAgents';
import { inSystemDbContext } from '../outcomeProbes';
import { TROUBLESHOOT_PROPOSABLE_TOOLS } from './troubleshootProfile';

export { assertTroubleshootAgentEdit, TroubleshootAgentEditError } from './troubleshootAgentEdit';

export class TroubleshootBaselineConflictError extends Error {
  readonly code = 'troubleshoot_agent_not_system_provisioned' as const;
  constructor(readonly partnerId: string) {
    super(`Partner ${partnerId} already has a live partner-level troubleshoot agent that was not provisioned by the system`);
    this.name = 'TroubleshootBaselineConflictError';
  }
}

async function readBaseline(partnerId: string): Promise<{ id: string; provisionedBy: string | null } | null> {
  const [row] = await db.select({ id: aiAgents.id, provisionedBy: aiAgents.provisionedBy }).from(aiAgents).where(and(
    eq(aiAgents.partnerId, partnerId), isNull(aiAgents.orgId), eq(aiAgents.kind, 'troubleshoot'), isNull(aiAgents.disabledAt),
  )).limit(1);
  return row ?? null;
}

function adopt(partnerId: string, row: { id: string; provisionedBy: string | null }): { agentId: string; created: false } {
  if (row.provisionedBy !== TROUBLESHOOT_PROVISIONER) throw new TroubleshootBaselineConflictError(partnerId);
  return { agentId: row.id, created: false };
}

/**
 * Callers must NOT invoke this while holding a request DB transaction:
 * `inSystemDbContext` opens a second pooled connection from inside one
 * (double-holds the pool, #2417). The launcher calls it from the coordinator's
 * admission path, which runs outside a request transaction.
 */
export async function ensureTroubleshootAgent(partnerId: string): Promise<{ agentId: string; created: boolean }> {
  return inSystemDbContext(async () => {
    const existing = await readBaseline(partnerId);
    if (existing) return adopt(partnerId, existing);
    const [inserted] = await db.insert(aiAgents).values({
      partnerId,
      orgId: null,
      kind: 'troubleshoot',
      name: TROUBLESHOOT_AGENT_NAME,
      enabled: true,
      mode: 'shadow',
      toolAllowlist: [...TROUBLESHOOT_PROPOSABLE_TOOLS],
      instructions: null,
      createdBy: null,
      provisionedBy: TROUBLESHOOT_PROVISIONER,
    }).onConflictDoNothing({
      target: [aiAgents.partnerId, aiAgents.kind],
      where: sql`${aiAgents.orgId} IS NULL AND ${aiAgents.disabledAt} IS NULL`,
    }).returning({ id: aiAgents.id });
    if (inserted) return { agentId: inserted.id, created: true };
    const winner = await readBaseline(partnerId);
    if (!winner) throw new Error(`[troubleshootProvisioning] troubleshoot agent for partner ${partnerId} vanished after a lost insert race`);
    return adopt(partnerId, winner);
  }, 'troubleshootProvisioning.ensure');
}
