import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands, devices, scriptExecutionBatches, scriptExecutions } from '../db/schema';
import { PG_UUID_REGEX } from '../utils/uuid';
import type { ClaimedCommand } from './commandDelivery';
import { SCRIPT_SECRET_ENVELOPE_FIELD } from './scriptSecretEnvelope';
import { getActiveSecretEncryptionKeyId } from './secretCrypto';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { captureException } from './sentry';

/**
 * #3409 PR4c-2 — the activation gates for secret delivery.
 *
 * A `tenantSecret` parameter reaches the agent only inside the sealed
 * `secretEnvEnvelope` (scriptSecretEnvelope.ts), and only an agent that
 * declares `scriptSecretEnvVersion >= 1` (PR4b) knows to open it and export
 * `BREEZE_VAR_<NAME>`. An older agent silently ignores the field and runs the
 * script with the credential UNSET — so the rule is "fail loudly, never run":
 *
 *   - `secretDeliveryPreflight` at ENQUEUE (scriptDispatch), before the
 *     execution row exists, so a refused dispatch leaves no orphan.
 *   - `failClaimedSecretCommandsForUnsupportedAgent` at CLAIM (commandDelivery),
 *     because the capability is non-sticky (devices.ts: written every beat)
 *     and an agent can be downgraded between enqueue and delivery.
 *
 * User-context runs are refused too: the helper IPC carries no env, mirroring
 * the agent's own `runAsSupportsSecrets`
 * (agent/internal/heartbeat/handlers_script.go).
 *
 * Nothing in this module ever sees a plaintext secret — it handles the
 * ciphertext envelope only as an opaque presence check — and no log line or
 * error string here carries the payload.
 */

/** The `devices.script_secret_env_version` floor written by a PR4b agent. */
export const SCRIPT_SECRET_ENV_REQUIRED_VERSION = 1;

export const SECRETS_RUN_AS_MESSAGE =
  'This script uses secret variables, which require system-context execution; it is configured to run as a user and was not executed';

export const SECRET_DELIVERY_UNAVAILABLE_MESSAGE =
  'Secret delivery is not configured on this server (no active secret-encryption key); script not executed';

export const AGENT_UPGRADE_REQUIRED_MESSAGE =
  'Agent upgrade required: this script uses secret variables and the device agent does not support secure secret delivery; script not executed';

export type ScriptRunAs = 'system' | 'user' | 'elevated';

export type SecretDeliveryPreflightFailureCode =
  | 'secrets_unsupported_run_as'
  | 'secret_delivery_unavailable'
  | 'agent_upgrade_required';

export type SecretDeliveryPreflightResult =
  | { ok: true }
  | { ok: false; code: SecretDeliveryPreflightFailureCode; error: string };

/**
 * Server-side mirror of the agent's `runAsSupportsSecrets`: `system` and
 * `elevated` (the default, when unset) run under the service and can receive
 * env; `user`, or ANY targeted session, is executed through the helper IPC
 * which carries no environment — the secret would simply be absent.
 */
export function runAsSupportsSecretEnv(
  runAs: ScriptRunAs | undefined,
  targetSessionId: number | null | undefined,
): boolean {
  if (targetSessionId != null) return false;
  return runAs !== 'user';
}

async function loadScriptSecretEnvVersions(deviceIds: string[]): Promise<Map<string, number>> {
  const [first] = deviceIds;
  if (first === undefined) return new Map();
  const rows = await db
    .select({ id: devices.id, scriptSecretEnvVersion: devices.scriptSecretEnvVersion })
    .from(devices)
    .where(deviceIds.length === 1 ? eq(devices.id, first) : inArray(devices.id, deviceIds));
  return new Map(rows.map((row) => [row.id, row.scriptSecretEnvVersion]));
}

/** Live read of the non-sticky capability; `null` when the device row is gone. */
export async function loadScriptSecretEnvVersion(deviceId: string): Promise<number | null> {
  const versions = await loadScriptSecretEnvVersions([deviceId]);
  return versions.get(deviceId) ?? null;
}

function agentSupportsSecretEnv(version: number | null | undefined): boolean {
  return typeof version === 'number' && version >= SCRIPT_SECRET_ENV_REQUIRED_VERSION;
}

/**
 * Enqueue-time gate. Checks are ordered cheapest / most deterministic first so
 * a refused dispatch costs no query: run-as → server key → agent capability.
 */
export async function secretDeliveryPreflight(input: {
  deviceId: string;
  runAs: ScriptRunAs | undefined;
  targetSessionId?: number | null;
}): Promise<SecretDeliveryPreflightResult> {
  if (!runAsSupportsSecretEnv(input.runAs, input.targetSessionId)) {
    return { ok: false, code: 'secrets_unsupported_run_as', error: SECRETS_RUN_AS_MESSAGE };
  }
  if (getActiveSecretEncryptionKeyId() === null) {
    return { ok: false, code: 'secret_delivery_unavailable', error: SECRET_DELIVERY_UNAVAILABLE_MESSAGE };
  }
  const version = await loadScriptSecretEnvVersion(input.deviceId);
  if (!agentSupportsSecretEnv(version)) {
    return { ok: false, code: 'agent_upgrade_required', error: AGENT_UPGRADE_REQUIRED_MESSAGE };
  }
  return { ok: true };
}

function carriesSecretEnvelope(cmd: ClaimedCommand): boolean {
  if (cmd.type !== 'script') return false;
  const payload = cmd.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const envelope = (payload as Record<string, unknown>)[SCRIPT_SECRET_ENVELOPE_FIELD];
  return typeof envelope === 'string' && envelope.length > 0;
}

/**
 * Mark the linked `script_executions` row failed and spend its batch slot.
 *
 * This is deliberately NOT `propagateTimedOutDeviceCommand`
 * (jobs/staleCommandReaper.ts): that helper fails linked `restore_jobs` and
 * kicks DR reconcile — it never touches `script_executions`, and its
 * `timedOutBy: 'server'` stamp is a load-bearing #3607 marker that would be a
 * lie here. A script command has no restore job, so calling it would be a
 * no-op dressed up as propagation.
 *
 * Mirrors `handleScriptResult` (commandResultHandlers.ts) instead: the same
 * `(id, deviceId, status IN non-terminal)` guard, the same scriptId-scoped
 * batch counter bump, counted only when THIS write drove the row terminal so
 * a lost race never double-spends the batch slot. Leaves `exitCode`/`stdout`
 * NULL on purpose — that is the #3607 "never received the agent's output"
 * discriminator, and there genuinely is none.
 */
async function failLinkedScriptExecution(cmd: ClaimedCommand, completedAt: Date): Promise<void> {
  const payload = cmd.payload as Record<string, unknown>;
  const executionId = payload.executionId;
  if (typeof executionId !== 'string' || !PG_UUID_REGEX.test(executionId)) return;

  const updated = await db
    .update(scriptExecutions)
    .set({ status: 'failed', completedAt, errorMessage: AGENT_UPGRADE_REQUIRED_MESSAGE })
    .where(
      and(
        eq(scriptExecutions.id, executionId),
        eq(scriptExecutions.deviceId, cmd.deviceId),
        inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
      ),
    )
    .returning({ id: scriptExecutions.id, scriptId: scriptExecutions.scriptId });

  const batchId = payload.batchId;
  if (typeof batchId !== 'string' || !updated[0]) return;
  await db
    .update(scriptExecutionBatches)
    .set({ devicesFailed: sql`${scriptExecutionBatches.devicesFailed} + 1` })
    .where(
      and(
        eq(scriptExecutionBatches.id, batchId),
        eq(scriptExecutionBatches.scriptId, updated[0].scriptId),
      ),
    );
}

function reportGateFailure(stage: string, cmd: ClaimedCommand, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[scriptSecretDelivery] ${stage} failed for secret-bearing command`, {
    commandId: cmd.id,
    deviceId: cmd.deviceId,
    error: message,
  });
  captureException(
    new Error(
      `[scriptSecretDelivery] ${stage} failed (commandId=${cmd.id}, deviceId=${cmd.deviceId}): ${message}`,
    ),
  );
}

/**
 * Claim-time gate. Runs BEFORE decryption on every batch
 * `claimPendingCommandsForDevice` hands to delivery (heartbeat main,
 * watchdog, REST poll).
 *
 * Cost model: zero queries unless some claimed `script` command actually
 * carries an envelope, then exactly ONE capability select for the batch
 * however many devices it spans. Offending commands are driven terminal —
 * `failed`, `result.exitCode: 1`, payload erased via
 * `terminalPayloadErasureSet` — guarded on `status = 'sent'` so a row
 * something else already moved is never overwritten, then propagated to the
 * linked execution. They are NOT released back to `pending` (unlike a
 * decrypt failure, #2414): an incapable agent would just re-claim them.
 *
 * Every failure path withholds the command from the returned batch. A
 * command whose terminal write or propagation throws is reported to Sentry
 * and still withheld; its siblings are always returned.
 */
export async function failClaimedSecretCommandsForUnsupportedAgent(
  claimed: ClaimedCommand[],
): Promise<ClaimedCommand[]> {
  const gated = claimed.filter(carriesSecretEnvelope);
  if (gated.length === 0) return claimed;

  const versions = await loadScriptSecretEnvVersions([...new Set(gated.map((cmd) => cmd.deviceId))]);
  const unsupported = gated.filter((cmd) => !agentSupportsSecretEnv(versions.get(cmd.deviceId)));
  if (unsupported.length === 0) return claimed;

  for (const cmd of unsupported) {
    const completedAt = new Date();
    console.warn('[scriptSecretDelivery] withholding secret-bearing script from an agent without secret-env support; failing it', {
      commandId: cmd.id,
      deviceId: cmd.deviceId,
      scriptSecretEnvVersion: versions.get(cmd.deviceId) ?? null,
      requiredVersion: SCRIPT_SECRET_ENV_REQUIRED_VERSION,
    });

    let drivenTerminal = false;
    try {
      const updated = await db
        .update(deviceCommands)
        .set({
          status: 'failed',
          completedAt,
          result: { status: 'failed', error: AGENT_UPGRADE_REQUIRED_MESSAGE, exitCode: 1 },
          ...terminalPayloadErasureSet(),
        })
        .where(and(eq(deviceCommands.id, cmd.id), eq(deviceCommands.status, 'sent')))
        .returning({ id: deviceCommands.id });
      drivenTerminal = updated.length > 0;
    } catch (err) {
      reportGateFailure('terminal update', cmd, err);
      continue;
    }
    if (!drivenTerminal) continue;

    try {
      await failLinkedScriptExecution(cmd, completedAt);
    } catch (err) {
      reportGateFailure('execution propagation', cmd, err);
    }
  }

  const withheld = new Set(unsupported.map((cmd) => cmd.id));
  return claimed.filter((cmd) => !withheld.has(cmd.id));
}
