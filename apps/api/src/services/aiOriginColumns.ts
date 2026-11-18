import type { AiOriginRef } from '@breeze/shared';

/**
 * Column triple for an insert into `device_commands` / `script_executions`
 * (#5022 W01).
 *
 * NOT interchangeable with `serializeAiOrigin` from `@breeze/shared`, which
 * produces the `ai_origin_*` names used by `action_intents` (prefixed there to
 * avoid colliding with its existing `origin_principal_*` pair). Same
 * `AiOriginRef` in, different column names out.
 *
 * Always emits all three keys, explicitly NULL when there is no origin: an
 * undefined key is dropped by Drizzle and would leave the column at whatever
 * the row default is, which is exactly the "unattributed by omission" failure
 * this wave exists to remove.
 *
 * Lives in its own leaf module rather than inside `commandQueue.ts` because
 * both insert chokepoints need it and `./commandQueue` is `vi.mock`ed by a
 * dozen suites — a helper exported from there would have to be re-declared in
 * every one of those mock factories.
 */
/** `audit_logs.actor_id` is NOT NULL; the sentinel for "no person / no agent row". */
export const SYSTEM_AUDIT_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export interface AiOriginAuditActor {
  actorType: 'user' | 'ai_agent' | 'system';
  actorId: string;
  initiatedBy: 'ai' | 'automation';
  /** The `aiOriginColumns` triple, plus `flowRunId` for a flow origin. */
  originDetails: Record<string, unknown>;
}

/**
 * Who an AI-surface device dispatch is audited as (#5022 W01; tool catalog W04
 * #5219, Open Decision 16). ONE mapping for every dispatch audit row
 * (`ai.command.executed`, `ai.script.executed`, the system-cleanup run row), so
 * the three cannot disagree:
 *
 *  - `ai_agent`     ⇒ the agent (`ai_agents.id` — legal in `audit_logs.actor_id`,
 *                     which has no users FK), initiated by AI;
 *  - `flow`         ⇒ SYSTEM automation, never a user (the flow's attribution id
 *                     is not a users row) and never an AI decision (a flow is
 *                     deterministic automation a human enabled); the run is in
 *                     the details, since `flow_run_id` has no column on
 *                     device_commands / script_executions;
 *  - `ai_assistant` ⇒ the human who asked, initiated by AI.
 */
export function aiOriginAuditActor(
  aiOrigin: AiOriginRef,
  ids: { agentActorId: string | null | undefined; humanActorId: string | null | undefined },
): AiOriginAuditActor {
  const columns = aiOriginColumns(aiOrigin);
  if (aiOrigin.kind === 'flow') {
    return {
      actorType: 'system',
      actorId: SYSTEM_AUDIT_ACTOR_ID,
      initiatedBy: 'automation',
      originDetails: { ...columns, flowRunId: aiOrigin.flowRunId ?? null },
    };
  }
  if (aiOrigin.kind === 'ai_agent') {
    return { actorType: 'ai_agent', actorId: ids.agentActorId ?? SYSTEM_AUDIT_ACTOR_ID, initiatedBy: 'ai', originDetails: columns };
  }
  return { actorType: 'user', actorId: ids.humanActorId ?? SYSTEM_AUDIT_ACTOR_ID, initiatedBy: 'ai', originDetails: columns };
}

export function aiOriginColumns(origin: AiOriginRef | undefined): {
  aiInitiatorKind: AiOriginRef['kind'] | null;
  aiSessionId: string | null;
  aiAgentRunId: string | null;
} {
  return {
    aiInitiatorKind: origin?.kind ?? null,
    aiSessionId: origin?.sessionId ?? null,
    aiAgentRunId: origin?.agentRunId ?? null,
  };
}
