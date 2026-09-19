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
