import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { devices, scriptExecutions, scripts } from '../db/schema';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { queueCommand } from './commandQueue';
import {
  decryptCommandForDelivery,
  encryptSensitivePayloadFields,
} from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';

/**
 * Single seam through which every script reaches a device (#3409 PR 0).
 * Owns: invariant checks → script_executions row (saved sources) → payload
 * build → sensitive-field encryption at enqueue → queueCommand (audit +
 * dispatch metrics) → claim / JIT-decrypt / WS send / release.
 *
 * Callers own: auth, site permissions, maintenance windows, batching, and
 * any caller-specific status bookkeeping (e.g. automation's 'queued' state).
 * Inserts run in the caller's ambient DB context — request paths stay under
 * RLS; system-context callers must validate ownership before calling.
 */
export type ScriptDispatchSource =
  | { kind: 'saved'; script: typeof scripts.$inferSelect }
  | { kind: 'raw'; content: string; language: string; provenance: string };

export type DispatchScriptInput = {
  device: Pick<typeof devices.$inferSelect, 'id' | 'orgId' | 'osType' | 'status' | 'agentId'>;
  source: ScriptDispatchSource;
  parameters?: Record<string, unknown>;
  triggerType?: string;
  triggeredBy?: string | null;
  createdBy?: string | null;
  runAs?: 'system' | 'user';
  timeoutSeconds?: number;
  targetSessionId?: number;
  batchId?: string | null;
  automationRunId?: string | null;
  requireOnline?: boolean;
  deliver?: boolean;
};

export type DispatchScriptResult =
  | { ok: true; commandId: string; executionId: string | null; delivered: boolean; executedAt: Date | null }
  | { ok: false; code: 'device_decommissioned' | 'device_offline' | 'os_mismatch' | 'org_mismatch' | 'insert_failed'; error: string };

export async function dispatchScriptToDevice(input: DispatchScriptInput): Promise<DispatchScriptResult> {
  const { device, source } = input;

  if (device.status === 'decommissioned') {
    return { ok: false, code: 'device_decommissioned', error: 'Device is decommissioned' };
  }
  if (input.requireOnline && device.status !== 'online') {
    return { ok: false, code: 'device_offline', error: `Device is ${device.status}, cannot execute command` };
  }

  if (source.kind === 'saved') {
    const script = source.script;
    // Org-equality invariant (mirrors scriptExecution.ts / playbooks.ts): an
    // org-less script (system or partner-wide) is universally runnable, but a
    // non-null script org must match the target device's org.
    if (script.orgId !== null && script.orgId !== device.orgId) {
      return { ok: false, code: 'org_mismatch', error: 'Script and device must belong to the same organization' };
    }
    if (!script.osTypes.includes(device.osType)) {
      return { ok: false, code: 'os_mismatch', error: 'Script is not compatible with device OS' };
    }
  }

  const parameters = input.parameters ?? {};
  const language = source.kind === 'saved' ? source.script.language : source.language;
  const content = source.kind === 'saved' ? source.script.content : source.content;
  const runAs = input.runAs ?? (source.kind === 'saved' ? source.script.runAs : 'system');
  const timeoutSeconds = input.timeoutSeconds ?? (source.kind === 'saved' ? source.script.timeoutSeconds : 300);
  const payloadScriptId = source.kind === 'saved' ? source.script.id : source.provenance;

  let executionId: string | null = null;
  if (source.kind === 'saved') {
    // Child rows always take the DEVICE's org (partner-wide fan-out rule).
    const [execution] = await db
      .insert(scriptExecutions)
      .values({
        scriptId: source.script.id,
        deviceId: device.id,
        orgId: device.orgId,
        triggeredBy: input.triggeredBy ?? null,
        triggerType: input.triggerType ?? 'manual',
        ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
        parameters,
        status: 'pending',
      })
      .returning({ id: scriptExecutions.id });
    if (!execution) {
      return { ok: false, code: 'insert_failed', error: 'Failed to create execution' };
    }
    executionId = execution.id;
  }

  const payload = encryptSensitivePayloadFields('script', {
    scriptId: payloadScriptId,
    ...(executionId ? { executionId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    language,
    content,
    parameters,
    timeoutSeconds,
    runAs,
    ...(input.targetSessionId != null ? { targetSessionId: input.targetSessionId } : {}),
  });

  let command: Awaited<ReturnType<typeof queueCommand>>;
  try {
    command = await queueCommand(device.id, 'script', payload, input.createdBy ?? undefined);
  } catch (err) {
    // Don't leave an orphaned pending execution the reaper would later
    // mislabel 'timeout' (mirrors discardQueuelessExecution in automationRuntime).
    if (executionId) {
      await db.delete(scriptExecutions).where(and(
        eq(scriptExecutions.id, executionId),
        eq(scriptExecutions.status, 'pending'),
      ));
    }
    throw err;
  }
  if (!command) {
    return { ok: false, code: 'insert_failed', error: 'Failed to create command' };
  }

  let delivered = false;
  let executedAt: Date | null = null;
  if (device.agentId && input.deliver !== false) {
    const claimed = await claimPendingCommandForDelivery(command.id);
    if (claimed) {
      const deliverable = decryptCommandForDelivery({ id: command.id, type: 'script', payload });
      const sent = deliverable
        ? sendCommandToAgent(device.agentId, deliverable as { id: string; type: string; payload: Record<string, unknown> })
        : false;
      if (sent) {
        delivered = true;
        executedAt = claimed.executedAt;
        if (executionId) {
          // Guarded on pending: a fast agent can already have driven the row
          // terminal via handleScriptResult (see automationRuntime.ts:996).
          await db
            .update(scriptExecutions)
            .set({ status: 'running', startedAt: claimed.executedAt })
            .where(and(eq(scriptExecutions.id, executionId), eq(scriptExecutions.status, 'pending')));
        }
      } else {
        await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
      }
    }
  }

  return { ok: true, commandId: command.id, executionId, delivered, executedAt };
}
