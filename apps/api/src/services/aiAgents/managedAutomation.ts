import type { AiAgentKind } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { automations } from '../../db/schema';

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
    enabled: true,
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

  await db.update(automations)
    .set({
      ...(patch.name === undefined ? {} : { name: managedTriageAutomationName(patch.name) }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      updatedAt: new Date(),
    })
    .where(eq(automations.managedByAgentId, agentId));
}
