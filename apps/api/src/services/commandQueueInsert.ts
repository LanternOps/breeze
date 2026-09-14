import { deviceCommands } from '../db/schema';
import { aiOriginColumns } from './aiOriginColumns';
import type { AiOriginRef } from '@breeze/shared';
// TYPE-ONLY, and load-bearing that it stays that way: `commandQueue.ts`
// statically imports `routes/agentWs.ts`, and a RUNTIME edge from this module
// to it would re-create the worker-closure regression this file exists to
// avoid. Type imports are erased, so this is inert at runtime — see the header
// below and `workerEntrypointClosure.contract.test.ts`.
import type { CommandPayload, CommandQueueTx, CommandType, QueuedCommand } from './commandQueue';

/**
 * Persist a command inside a caller-owned transaction, with no dispatch side
 * effects — one of the insert chokepoints `aiDispatch.contract.test.ts`
 * enforces (#5022 W01).
 *
 * It lives in its own leaf module rather than in `commandQueue.ts` for an
 * import-closure reason, not a stylistic one. `commandQueue.ts` statically
 * imports `routes/agentWs.ts` (the live agent-socket registry), and
 * `services/peripheralPolicyState.ts` — which must reach this function to stop
 * hand-rolling its own `device_commands` insert — sits in the closure of
 * `jobs/peripheralJobs.ts` -> `services/groupMembership.ts` ->
 * `services/contractQuantities.ts` -> the quote and contract workers. Importing
 * `commandQueue.ts` from there drags the socket registry into two
 * `global`-placement worker processes, which
 * `workerEntrypointClosure.contract.test.ts` (#4086) forbids outright — and a
 * lazy `await import()` does not help, because that test's per-entry check
 * follows dynamic edges too.
 *
 * So the rule for this file: it may import schema, pure helpers and TYPES, and
 * nothing that reaches `routes/`.
 */
export async function insertQueuedCommandInTransaction(
  tx: CommandQueueTx,
  input: {
    id: string;
    deviceId: string;
    type: CommandType;
    payload: CommandPayload;
    /**
     * `device_commands.created_by` is a NULLABLE uuid. Pass `null` for a
     * synthetic principal that `resolveCommandCreatedBy` degraded — NOT `''`,
     * which Postgres rejects with `22P02 invalid input syntax for type uuid`
     * and which rolls back the caller's whole transaction (#3525 W02b).
     */
    createdBy: string | null;
    /** #5022 W01 — who DECIDED this command, when an AI surface did. */
    aiOrigin?: AiOriginRef;
    /**
     * Which consumer on the device picks this up. Defaults to 'agent' (the
     * column default). Needed so callers that previously hand-rolled an insert
     * straight into the table to set it can route through this chokepoint
     * instead — see `aiDispatch.contract.test.ts`.
     */
    targetRole?: 'agent' | 'watchdog';
  },
): Promise<QueuedCommand> {
  const [command] = await tx
    .insert(deviceCommands)
    .values({
      id: input.id,
      deviceId: input.deviceId,
      type: input.type,
      payload: input.payload,
      status: 'pending',
      createdBy: input.createdBy,
      ...(input.targetRole ? { targetRole: input.targetRole } : {}),
      ...aiOriginColumns(input.aiOrigin),
    })
    .returning();
  if (!command) throw new Error('failed to persist queued command');
  return command as QueuedCommand;
}
