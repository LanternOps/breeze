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
 *     execution row exists, so a refused dispatch leaves no orphan. This is
 *     the ORDINARY case for any pre-PR4b agent, and it refuses with
 *     `agent_upgrade_required`.
 *   - `failClaimedSecretCommandsForUnsupportedAgent` at CLAIM (commandDelivery),
 *     because the capability is non-sticky (devices.ts: written every beat)
 *     and an agent can be downgraded between enqueue and delivery. RARE (it
 *     needs a downgrade race), and by the time it refuses it has already
 *     written both the command and the execution row — which is why dispatch
 *     reports it under the distinct `agent_upgrade_required_recorded` code.
 *
 * User-context runs — `user`, any explicit username, any targeted session —
 * are refused too: they execute through the helper IPC (or a `sudo -n`
 * re-exec), neither of which carries env, so the credential would simply be
 * absent. `runAsSupportsSecretEnv` mirrors the agent's own
 * `runAsSupportsSecrets` (agent/internal/heartbeat/handlers_script.go)
 * allowlist-for-allowlist.
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

/**
 * Shared by BOTH agent-capability refusals — the enqueue preflight's
 * `agent_upgrade_required` and the claim-time gate's
 * `agent_upgrade_required_recorded` (scriptDispatch.ts). The two codes exist
 * to say WHO already wrote the failure rows, which is a server-side
 * bookkeeping distinction; to the operator the remediation is identical, so
 * the text must not fork.
 */
export const AGENT_UPGRADE_REQUIRED_MESSAGE =
  'Agent upgrade required: this script uses secret variables and the device agent does not support secure secret delivery; script not executed';

/**
 * The claim-time gate FAULTED (its capability select threw, or its
 * single-agent contract was violated) rather than returning a verdict.
 *
 * Deliberately says nothing about the agent's version: the agent may be
 * perfectly current, and `AGENT_UPGRADE_REQUIRED_MESSAGE` would send the
 * operator to upgrade software over what is a server-side fault. Nothing is
 * written on that path, so the refusal it carries
 * (`secret_gate_unavailable`) takes the ordinary per-device failure row.
 */
export const SECRET_GATE_UNAVAILABLE_MESSAGE =
  'The server could not verify this device\'s secret-delivery capability, and this script uses secret variables; script not executed';

export type ScriptRunAs = 'system' | 'user' | 'elevated';

/**
 * The ENQUEUE-time refusals only. All three return BEFORE the
 * `script_executions` insert, so each one leaves NO rows behind and the
 * fan-out owes the device its ordinary failure row — including
 * `agent_upgrade_required`, which is the ordinary outcome for any pre-PR4b
 * agent and therefore the common case, not an edge one.
 *
 * The claim-time gate's refusal is deliberately NOT in this union: it arrives
 * with the command AND execution rows already written, so it carries the
 * distinct `agent_upgrade_required_recorded` code (declared on
 * `DispatchScriptResult` in scriptDispatch.ts, and the sole member of
 * `DISPATCH_CODES_ALREADY_RECORDED` in scriptExecution.ts). Sharing one code
 * between the two suppressed the enqueue case's failure row entirely.
 */
export type SecretDeliveryPreflightFailureCode =
  | 'secrets_unsupported_run_as'
  | 'secret_delivery_unavailable'
  | 'agent_upgrade_required';

export type SecretDeliveryPreflightResult =
  | { ok: true }
  | { ok: false; code: SecretDeliveryPreflightFailureCode; error: string };

/**
 * Server-side mirror of the agent's `runAsSupportsSecrets`
 * (agent/internal/heartbeat/handlers_script.go): unset/`system` (and
 * `elevated`) run under the service and can receive env; `user`, ANY explicit
 * username, or ANY targeted session is executed through the helper IPC — or
 * re-exec'd through `sudo -n` — which carries no environment, so the secret
 * would simply be absent.
 *
 * Matched to the agent deliberately: same trim + lowercase, same ALLOWLIST
 * (an unrecognized value is a username, never a mode). The parameter is
 * `string` rather than `ScriptRunAs` because the value reaches us from stored
 * script config and API input, not only from the union.
 *
 * The one divergence we cannot model here: the agent admits `elevated` only
 * when `isRunningElevated()`, which is a runtime property of that host. So an
 * `elevated` run this predicate passes may still be refused agent-side —
 * fail-closed there, and modelling it server-side would be a guess. Every
 * other divergence is fail-closed at the agent too; tightening here only
 * moves the refusal EARLIER, to before the `script_executions` insert.
 */
export function runAsSupportsSecretEnv(
  runAs: string | null | undefined,
  targetSessionId: number | null | undefined,
): boolean {
  if (targetSessionId != null) return false;
  switch ((runAs ?? '').trim().toLowerCase()) {
    case '':
    case 'system':
    case 'elevated':
      return true;
    default:
      return false;
  }
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
 * The single expression that turns an agent's SELF-REPORTED capability into
 * the value stored in `devices.script_secret_env_version`: only the exact
 * recognized integer 1 counts, everything else (absent object, unknown future
 * value, a downgraded build) reports back down to 0.
 *
 * Shared with the heartbeat's device write so the value the gate trusts and
 * the value the column stores can never drift apart.
 */
export function normalizeReportedScriptSecretEnvVersion(reported: unknown): number {
  return reported === 1 ? 1 : 0;
}

/**
 * Enqueue-time gate. Checks are ordered cheapest / most deterministic first so
 * a refused dispatch costs no query: run-as → server key → agent capability.
 *
 * Returns `agent_upgrade_required` (never the claim-time
 * `agent_upgrade_required_recorded`): nothing has been written when this
 * refuses, so the caller must record the device's failure itself.
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
  // A missing device row (`null`) refuses here, unlike at CLAIM time where it
  // only WITHHOLDS. The asymmetry is deliberate: refusing an enqueue destroys
  // nothing — no command row, no execution row, nothing to erase, and the
  // caller gets an immediate error it can retry. At claim time the command
  // already exists with its sealed payload, so treating "row not found" as
  // "agent too old" would irreversibly erase that payload over what may be an
  // RLS/context regression or replica lag. See
  // `failClaimedSecretCommandsForUnsupportedAgent`.
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
  if (typeof executionId !== 'string' || !PG_UUID_REGEX.test(executionId)) {
    // Not an error (an ad-hoc command legitimately has no execution row), but
    // it must leave a trace: without one, a `script_executions` row that IS
    // linked under a key we failed to read stays non-terminal and the reaper
    // later reports it as an agent timeout rather than a server-side refusal.
    console.warn(
      '[scriptSecretDelivery] withheld command has no linked script execution to fail (missing or non-uuid executionId)',
      { commandId: cmd.id, deviceId: cmd.deviceId },
    );
    return;
  }

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
 * however many devices it spans — and ZERO selects when the caller already
 * knows the answer (see `opts.reportedVersion`).
 *
 * Three outcomes per envelope-bearing command:
 *
 *   1. Device row EXISTS and meets the floor → delivered untouched.
 *   2. Device row EXISTS and reports below the floor → a real capability
 *      claim, so the command is driven terminal (`failed`,
 *      `result.exitCode: 1`, payload erased via `terminalPayloadErasureSet`,
 *      guarded on `status = 'sent'` so a row something else already moved is
 *      never overwritten) and propagated to the linked execution. NOT
 *      released back to `pending` (unlike a decrypt failure, #2414): an
 *      incapable agent would just re-claim it.
 *   3. Device row NOT RETURNED AT ALL → unknown, never assumed to be 0. The
 *      command is withheld and reported to Sentry, but nothing is written:
 *      the row stays `sent` for the stale reaper, so the refusal stays
 *      reversible rather than erasing a payload over an RLS/context
 *      regression, a mid-batch delete, or replica lag.
 *
 * Every failure path withholds the command from the returned batch. A
 * command whose terminal write or propagation throws is reported to Sentry
 * and still withheld; its siblings are always returned.
 */
export async function failClaimedSecretCommandsForUnsupportedAgent(
  claimed: ClaimedCommand[],
  opts?: {
    /**
     * The capability the agent reported in THIS request. When present it is
     * AUTHORITATIVE and no `devices` select is issued at all. Callers should
     * pass a `normalizeReportedScriptSecretEnvVersion` value, but the gate
     * re-normalizes defensively so an un-normalized future value cannot
     * widen it.
     *
     * Why: the heartbeat writes this column non-sticky (routes/agents/
     * heartbeat.ts) but that write is guarded on the device not being
     * decommissioned/quarantined, and it is a separate statement from the
     * claim. If the write is skipped — or simply loses the race — a STORED
     * value of 1 would let a batch through for an agent that just reported 0
     * in the very same beat. The reported value cannot be stale by
     * construction, so prefer it.
     *
     * It describes exactly ONE agent, so a batch spanning several devices
     * must not be passed with it — that is ENFORCED (throws), not assumed:
     * otherwise device A's self-report could authorise device B's secret.
     * There is no such caller today (one device per beat).
     */
    reportedVersion?: number;
  },
): Promise<ClaimedCommand[]> {
  const gated = claimed.filter(carriesSecretEnvelope);
  if (gated.length === 0) return claimed;

  // Normalize defensively rather than trusting the docblock: the gate below
  // compares with `>= SCRIPT_SECRET_ENV_REQUIRED_VERSION` while the stored
  // column only ever holds `normalizeReportedScriptSecretEnvVersion`'s
  // `=== 1`. A future caller that forgot to normalize must not be able to
  // widen the gate by handing us an unrecognized `2`. `undefined` (not
  // supplied) stays distinguishable from a reported `0`.
  const reportedVersion =
    typeof opts?.reportedVersion === 'number'
      ? normalizeReportedScriptSecretEnvVersion(opts.reportedVersion)
      : undefined;

  const deviceIds = [...new Set(gated.map((cmd) => cmd.deviceId))];
  if (reportedVersion !== undefined && deviceIds.length > 1) {
    // ENFORCED, not merely documented: a reported version is ONE agent's
    // self-report about ITSELF. Spreading it over a batch would let device
    // A's report authorise a sealed secret for device B. No caller does this
    // today (one device per heartbeat); a future batched-claim optimisation
    // must fail loudly here instead of silently mis-authorising.
    throw new Error(
      `[scriptSecretDelivery] opts.reportedVersion is a single agent's self-report and cannot authorise a batch spanning ${deviceIds.length} devices`,
    );
  }

  const versions =
    reportedVersion !== undefined
      ? new Map(deviceIds.map((deviceId) => [deviceId, reportedVersion]))
      : await loadScriptSecretEnvVersions(deviceIds);

  const withheld = new Set<string>();
  for (const cmd of gated) {
    // `.has()`, not `?? null`: a device id ABSENT from the map means the row
    // was not returned at all — an RLS/context regression, a device deleted
    // mid-batch, replica lag — which is "we don't know", never a capability
    // claim of 0. Withhold (we will not ship a sealed secret on a guess) but
    // do NOT drive the command terminal: that write erases the payload
    // irreversibly and tells the operator to upgrade an agent that may be
    // perfectly current. Left `sent`, the stale reaper handles it and the
    // refusal stays reversible once the real cause is fixed.
    if (!versions.has(cmd.deviceId)) {
      withheld.add(cmd.id);
      reportGateFailure('device row not found', cmd, new Error('no devices row'));
      continue;
    }

    const version = versions.get(cmd.deviceId);
    if (agentSupportsSecretEnv(version)) continue;

    // The row EXISTS and reports below the floor: a real capability claim, so
    // the terminal write is warranted.
    withheld.add(cmd.id);
    const completedAt = new Date();
    console.warn('[scriptSecretDelivery] withholding secret-bearing script from an agent without secret-env support; failing it', {
      commandId: cmd.id,
      deviceId: cmd.deviceId,
      scriptSecretEnvVersion: version ?? null,
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
    if (!drivenTerminal) {
      // Zero rows on a row claimed microseconds ago: something else moved it
      // off `sent` mid-flight. Correct to skip propagation (whatever moved it
      // owns the outcome), but not to skip SILENTLY — the linked execution
      // row is left non-terminal and a later reaper pass would mislabel this
      // server-side refusal an agent timeout.
      console.warn('[scriptSecretDelivery] withheld command was no longer `sent`; skipping execution propagation', {
        commandId: cmd.id,
        deviceId: cmd.deviceId,
      });
      reportGateFailure('terminal update claim race', cmd, new Error('0 rows updated'));
      continue;
    }

    try {
      await failLinkedScriptExecution(cmd, completedAt);
    } catch (err) {
      reportGateFailure('execution propagation', cmd, err);
    }
  }

  if (withheld.size === 0) return claimed;
  return claimed.filter((cmd) => !withheld.has(cmd.id));
}
