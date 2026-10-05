/**
 * Agent runs blocked by the model registry (AI model registry W03, spec §9.1,
 * §9.1a). A run whose model is unavailable at admission or dispatch, or that
 * the model refused, ends `blocked` (or is skipped `model_unavailable` at
 * admission) instead of `failed`: an admin's model choice is not an agent
 * fault, so it is circuit-neutral (agentCircuit.classifyTerminal).
 *
 * Notifications are deduped per (org, agent, reason, UTC day) through
 * user_notifications_user_dedupe_key_uq, i.e. at most once per policy per day.
 */
import type { AiAgentRecipients } from '@breeze/shared';
import { inSystemDbContext } from '../outcomeProbes';
import { createNotification } from '../userNotifications';
import { resolveRecipientUserIds } from './recipients';

export type ModelBlockedReason = 'model_unavailable' | 'model_refused';

/**
 * Thrown inside the run loop; the run's catch moves it `running → blocked`
 * with `errorCode` / `outcome`, plus what it spent when the model was called
 * (a refusal is billed: the provider ran the request).
 */
export class AgentRunBlockedError extends Error {
  readonly errorCode: ModelBlockedReason;
  readonly outcome: Record<string, unknown>;
  readonly spent: { costCents: number; turnCount: number } | null;
  /** False for a transient registry state (cutover not done): there is nothing for an admin to fix. */
  readonly notify: boolean;

  constructor(
    errorCode: ModelBlockedReason,
    outcome: Record<string, unknown>,
    message: string,
    opts: { spent?: { costCents: number; turnCount: number }; notify?: boolean } = {},
  ) {
    super(message);
    this.name = 'AgentRunBlockedError';
    this.errorCode = errorCode;
    this.outcome = outcome;
    this.spent = opts.spent ?? null;
    this.notify = opts.notify ?? true;
  }
}

export function blockedOutcome(reason: ModelBlockedReason, detail: {
  message: string; refusalCategory?: string | null; offeringId?: string | null; requestedModel?: string | null;
}): Record<string, unknown> {
  return {
    blockedReason: reason,
    message: detail.message,
    ...(detail.refusalCategory !== undefined ? { refusalCategory: detail.refusalCategory } : {}),
    ...(detail.offeringId !== undefined ? { offeringId: detail.offeringId } : {}),
    ...(detail.requestedModel !== undefined ? { requestedModel: detail.requestedModel } : {}),
  };
}

export function modelBlockedDedupeKey(orgId: string, agentId: string, reason: ModelBlockedReason, now: Date): string {
  return `ai-model-blocked-${orgId}-${agentId}-${reason}-${now.toISOString().slice(0, 10)}`;
}

/** Best-effort by contract of its callers: they `.catch` and log, never fail a run on it. */
export async function notifyModelBlocked(input: {
  orgId: string;
  agentId: string;
  agentName: string;
  agent: { orgId: string | null; partnerId: string | null; recipients: Partial<AiAgentRecipients> };
  reason: ModelBlockedReason;
  message: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const userIds = await resolveRecipientUserIds(input.agent, input.orgId);
  if (userIds.length === 0) return;
  const title = input.reason === 'model_refused'
    ? `${input.agentName}: the AI model declined a run`
    : `${input.agentName}: its AI model is unavailable`;
  await inSystemDbContext(async () => {
    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId: input.orgId,
        type: 'ai',
        title,
        message: input.message,
        link: `/ai-agents/runs#agent=${input.agentId}`,
        priority: 'high',
        metadata: { agentId: input.agentId, reason: input.reason },
        dedupeKey: modelBlockedDedupeKey(input.orgId, input.agentId, input.reason, now),
      });
    }
  });
}
