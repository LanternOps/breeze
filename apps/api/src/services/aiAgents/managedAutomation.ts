import type { AiAgentKind } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { aiAgents, automations } from '../../db/schema';

/** Machine error code the routes return when a managed row is edited/triggered. */
export const MANAGED_AUTOMATION_ERROR_CODE = 'automation_managed_by_agent';
/** Machine error code the create route returns for a user-authored ai_triage action. */
export const AI_TRIAGE_SYSTEM_MANAGED_ERROR_CODE = 'ai_triage_is_system_managed';

export function managedTriageAutomationName(agentName: string): string {
  return `${agentName} — alert triage`;
}

export function isManagedAutomation(row: { managedByAgentId?: string | null }): boolean {
  // A partially-selected row that omits the column would read as MANAGED under
  // `!== null` and start rejecting every ordinary customer automation. Fail toward unmanaged.
  return typeof row.managedByAgentId === 'string';
}

export function containsAiTriageAction(actions: unknown): boolean {
  return Array.isArray(actions) && actions.some((action) => (
    action !== null
    && typeof action === 'object'
    && (action as Record<string, unknown>).type === 'ai_triage'
  ));
}

export interface ManagedAutomationAgent {
  id: string;
  kind: AiAgentKind;
  name: string;
  /**
   * The agent's own switch. The seeded row MIRRORS it rather than hardcoding
   * `true`: `createAiAgentSchema` defaults `enabled` to false (and so does the
   * column), so the normal flow — create the agent, configure it, turn it on —
   * would otherwise leave live wiring in front of an off agent. Every
   * alert.triggered in the org would then run the whole automation machinery
   * (run row, device-result row, runCount bump, execute-run job) only for the
   * admission gate to answer `agent_disabled`, while the Automations list
   * showed the row as Enabled and no route would let the user correct it.
   * Same rationale disableAgent states for the disable direction.
   */
  enabled: boolean;
  orgId: string | null;
  partnerId: string | null;
  createdBy: string | null;
}

export async function ensureManagedTriageAutomation(agent: ManagedAutomationAgent): Promise<void> {
  if (agent.kind !== 'triage') return;

  await db.insert(automations).values({
    orgId: agent.orgId,
    partnerId: agent.partnerId,
    name: managedTriageAutomationName(agent.name),
    description: 'System-managed: wakes the AI triage agent on alerts. Edit the agent, not this automation.',
    enabled: agent.enabled,
    // `eventType` is the canonical key (shapeAutomationForResponse reads it);
    // `event` is only a legacy alias normalizeAutomationTrigger still accepts.
    // NO `filter` here on purpose: severity/site/tag/maintenance/cooldown
    // filtering lives on the agent policy and is applied by 3c's admission
    // gate. One source of truth means there is nothing here to drift out of it.
    trigger: { type: 'event', eventType: 'alert.triggered' },
    actions: [{ type: 'ai_triage' }],
    onFailure: 'stop',
    createdBy: agent.createdBy,
    managedByAgentId: agent.id,
  }).onConflictDoNothing();
}

export async function setManagedAutomationEnabled(agentId: string, enabled: boolean): Promise<void> {
  await syncManagedAutomation(agentId, { enabled });
}

export async function syncManagedAutomation(
  agentId: string,
  patch: { name?: string; enabled?: boolean },
): Promise<void> {
  if (patch.name === undefined && patch.enabled === undefined) return;

  const updated = await db.update(automations)
    .set({
      ...(patch.name === undefined ? {} : { name: managedTriageAutomationName(patch.name) }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      updatedAt: new Date(),
    })
    .where(eq(automations.managedByAgentId, agentId))
    .returning({ id: automations.id });
  if (updated.length > 0) return;

  // Self-heal. A triage agent can legitimately have no managed row: it was
  // created before wave 3d shipped (the backfill migration covers the ones
  // that existed at deploy time, but not a restore from an older dump), or the
  // seed lost a race. Updating zero rows and returning silently would leave
  // that agent producing zero alert-driven runs forever with no error
  // anywhere, and the user cannot self-heal it either — updateAgent rejects a
  // disabled agent and ai_agents_org_kind_uq forbids a second live triage
  // agent, so the only other remedy is disable + recreate, losing the agent's
  // configuration and run history. Ensure-then-update instead.
  const [agent] = await db
    .select({
      id: aiAgents.id,
      kind: aiAgents.kind,
      name: aiAgents.name,
      enabled: aiAgents.enabled,
      orgId: aiAgents.orgId,
      partnerId: aiAgents.partnerId,
      createdBy: aiAgents.createdBy,
      disabledAt: aiAgents.disabledAt,
    })
    .from(aiAgents)
    .where(eq(aiAgents.id, agentId))
    .limit(1);
  // A soft-disabled agent gets NO new wiring: it can never be re-enabled
  // (updateAgent throws on disabledAt), so a row seeded here would be dead
  // weight the user then has to delete.
  if (!agent || agent.disabledAt) return;

  await ensureManagedTriageAutomation({
    ...agent,
    name: patch.name ?? agent.name,
    enabled: patch.enabled ?? agent.enabled,
  });
}

/**
 * Is the agent that owns a managed automation still live?
 *
 * Every writer refuses a managed row (REST update/delete/trigger, the fleet AI
 * tool, policy evaluation), and `disableAgent` only flips the row to
 * `enabled: false` — it keeps `managed_by_agent_id` pointing at the dead agent.
 * Without this, a disable leaves a row NO user can ever remove, and since a
 * disabled agent can never be re-enabled, the standard recovery (disable +
 * create a replacement) adds another undeletable row every cycle. Deletion of
 * a dead agent's wiring is therefore allowed; editing it is still not.
 *
 * Fails CLOSED: an agent row this context cannot read counts as live.
 */
export async function managedAutomationOwnerIsLive(agentId: string): Promise<boolean> {
  const [agent] = await db
    .select({ disabledAt: aiAgents.disabledAt })
    .from(aiAgents)
    .where(eq(aiAgents.id, agentId))
    .limit(1);
  return !agent?.disabledAt;
}
