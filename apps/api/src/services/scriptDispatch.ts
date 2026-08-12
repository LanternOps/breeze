import { and, eq } from 'drizzle-orm';
import { canonicalizeScriptParameters } from '@breeze/shared';

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
import { captureException } from './sentry';

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
  | { kind: 'saved'; script: typeof scripts.$inferSelect; automationRunId?: string | null }
  | { kind: 'raw'; content: string; language: string; provenance: string };

export type DispatchScriptInput = {
  device: Pick<typeof devices.$inferSelect, 'id' | 'orgId' | 'osType' | 'status' | 'agentId'>;
  source: ScriptDispatchSource;
  parameters?: Record<string, unknown>;
  triggerType?: 'manual' | 'scheduled' | 'alert' | 'policy' | 'automation';
  triggeredBy?: string | null;
  createdBy?: string | null;
  runAs?: 'system' | 'user' | 'elevated';
  timeoutSeconds?: number;
  targetSessionId?: number;
  batchId?: string | null;
  requireOnline?: boolean;
};

export type DispatchScriptResult =
  | {
      ok: true;
      commandId: string;
      executionId: string | null;
      delivered: boolean;
      // Distinguishes WHY `delivered` is false. 'no_agent' is the normal
      // "queued for later" case; 'claim_lost', 'decrypt_failed', and
      // 'send_failed' all mean we had a connected agent and still failed to
      // reach it — operationally different, and worth a log line (see below).
      deliveryOutcome: 'sent' | 'claim_lost' | 'decrypt_failed' | 'send_failed' | 'no_agent';
      executedAt: Date | null;
    }
  | {
      ok: false;
      code:
        | 'device_decommissioned'
        | 'device_offline'
        | 'os_mismatch'
        | 'org_mismatch'
        | 'insert_failed'
        // A {{var.*}} token in the script content had no resolvable value (or
        // resolved to a secret) for this device's org. Per-device — Task 4
        // (#3409 PR2) is what actually produces this code; this task only
        // gives the fan-out a channel to carry it without aborting the batch.
        | 'unresolved_variables';
      error: string;
    };

export async function dispatchScriptToDevice(input: DispatchScriptInput): Promise<DispatchScriptResult> {
  const { device, source } = input;

  // Decommission is permanent, so the caller's snapshot is fine for it — no
  // live re-read needed.
  if (device.status === 'decommissioned') {
    return { ok: false, code: 'device_decommissioned', error: 'Device is decommissioned' };
  }
  if (input.requireOnline) {
    // Re-read live status rather than trusting `device.status` (the caller's
    // snapshot). Automation fleet runs snapshot every target device ONCE at
    // run start (automationRuntime.ts:1712/2269) and can dispatch minutes
    // later, so a device that went offline in between must still be caught
    // here. This mirrors the old `queueCommandForExecution`
    // (commandQueue.ts:650), which re-selected `devices.status` fresh on
    // every dispatch — a deleted test once pinned the opposite contract
    // ("must NOT pre-filter on it") for this codepath, which this restores.
    // Only requireOnline gets the extra query: manual/route dispatch
    // deliberately queues offline devices, so no live read runs for it.
    const [liveDevice] = await db
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, device.id))
      .limit(1);
    if (!liveDevice) {
      // `code` stays 'device_offline' — every caller only branches on
      // ok/error text, never on `code`, so a distinct value isn't worth
      // adding just to distinguish "gone" from "offline" here.
      return { ok: false, code: 'device_offline', error: 'Device not found' };
    }
    if (liveDevice.status !== 'online') {
      return { ok: false, code: 'device_offline', error: `Device is ${liveDevice.status}, cannot execute command` };
    }
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
        ...(source.automationRunId ? { automationRunId: source.automationRunId } : {}),
        parameters,
        status: 'pending',
      })
      .returning({ id: scriptExecutions.id });
    if (!execution) {
      return { ok: false, code: 'insert_failed', error: 'Failed to create execution' };
    }
    executionId = execution.id;
  }

  // Discards a pending execution row that would otherwise be orphaned —
  // stuck 'pending' with no command for the reaper to later mislabel
  // 'timeout' (the #3162 failure mode, mirrors the old
  // discardQueuelessExecution in automationRuntime). Used on BOTH the
  // queueCommand-throws path and the queueCommand-resolves-falsy path: only
  // one of those raises, so a catch block alone used to miss the other.
  // `.returning` + a 0-row warning restores the diagnostic the old
  // discardQueuelessExecution had: a 0-row delete here means the row wasn't
  // 'pending' anymore for some other reason, which is worth knowing about.
  // The delete itself is wrapped in its own try/catch: a transient DB error
  // here must never replace or mask the ORIGINAL failure the caller is about
  // to see/return.
  const discardPendingExecution = async (reason: string) => {
    if (!executionId) return;
    try {
      const deleted = await db
        .delete(scriptExecutions)
        .where(and(eq(scriptExecutions.id, executionId), eq(scriptExecutions.status, 'pending')))
        .returning({ id: scriptExecutions.id });
      if (deleted.length === 0) {
        console.warn(
          '[scriptDispatch] execution row was not pending at discard time; leaving it alone',
          { executionId, deviceId: device.id, reason },
        );
      }
    } catch (cleanupErr) {
      console.error(
        '[scriptDispatch] failed to discard pending execution row',
        { executionId, deviceId: device.id, reason, error: cleanupErr },
      );
      captureException(cleanupErr);
    }
  };

  let payload: Record<string, unknown>;
  let command: Awaited<ReturnType<typeof queueCommand>>;
  let stage: 'payload build' | 'queueCommand' = 'payload build';
  try {
    // Payload build lives inside this guarded region (not after it) so a
    // throw here — no-op today (no 'script' entry in
    // SENSITIVE_PAYLOAD_FIELDS), but PR4 of #3409 adds one — also discards
    // the pending execution row instead of orphaning it.
    payload = encryptSensitivePayloadFields('script', {
      scriptId: payloadScriptId,
      ...(executionId ? { executionId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      language,
      content,
      // #3409 PR2 Task 7: canonicalize to strings ONCE, here, at the single
      // dispatch chokepoint — the agent's wire type is `map[string]string`
      // (agent/internal/executor/executor.go:39) and silently drops any
      // non-string value (agent/internal/heartbeat/handlers_script.go:37-43).
      // Every ingress (route, mobile, automation, AI tools, script builder,
      // remediation suggestions) funnels through here, so this is the one
      // place that guarantees the wire form regardless of caller.
      parameters: canonicalizeScriptParameters(parameters as Record<string, string | number | boolean>),
      timeoutSeconds,
      runAs,
      ...(input.targetSessionId != null ? { targetSessionId: input.targetSessionId } : {}),
    });
    stage = 'queueCommand';
    command = await queueCommand(device.id, 'script', payload, input.createdBy ?? undefined);
  } catch (err) {
    await discardPendingExecution(`${stage} threw`);
    throw err;
  }
  if (!command) {
    await discardPendingExecution('queueCommand returned no row');
    return { ok: false, code: 'insert_failed', error: 'Failed to create command' };
  }

  let delivered = false;
  let executedAt: Date | null = null;
  let deliveryOutcome: 'sent' | 'claim_lost' | 'decrypt_failed' | 'send_failed' | 'no_agent' = 'no_agent';
  if (device.agentId) {
    const claimed = await claimPendingCommandForDelivery(command.id);
    if (claimed) {
      const deliverable = decryptCommandForDelivery({ id: command.id, type: 'script', payload });
      const sent = deliverable
        ? sendCommandToAgent(device.agentId, deliverable as { id: string; type: string; payload: Record<string, unknown> })
        : false;
      if (sent) {
        delivered = true;
        deliveryOutcome = 'sent';
        executedAt = claimed.executedAt;
        if (executionId) {
          // Guarded on pending: a fast agent can already have driven the row
          // terminal (see handleScriptResult in services/commandResultHandlers.ts).
          await db
            .update(scriptExecutions)
            .set({ status: 'running', startedAt: claimed.executedAt })
            .where(and(eq(scriptExecutions.id, executionId), eq(scriptExecutions.status, 'pending')));
        }
      } else {
        // We had a claimed command and a connected agent and still failed to
        // reach it — operationally different from the normal "no agent
        // connected, queued for later" case, so this is worth a log line.
        deliveryOutcome = deliverable ? 'send_failed' : 'decrypt_failed';
        console.warn('[scriptDispatch] failed to deliver claimed command to connected agent', {
          commandId: command.id,
          deviceId: device.id,
          deliveryOutcome,
        });
        await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
      }
    } else {
      deliveryOutcome = 'claim_lost';
    }
  }

  return { ok: true, commandId: command.id, executionId, delivered, deliveryOutcome, executedAt };
}
