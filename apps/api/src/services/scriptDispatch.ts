import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { canonicalizeScriptParameters, hasVariableTokens } from '@breeze/shared';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations, scriptExecutions, scripts, sites, users } from '../db/schema';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { queueCommand } from './commandQueue';
import {
  decryptCommandForDelivery,
  toAgentCommandFrame,
  encryptSensitivePayloadFields,
} from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';
import { captureException } from './sentry';
import {
  describeVariableFailure,
  resolveForOrg,
  substituteTenantVariables,
  unreadableForOrg,
  type ResolvedVariable,
  type TenantVariableScope,
} from './tenantVariableResolution';
import {
  AGENT_UPGRADE_REQUIRED_MESSAGE,
  SECRET_GATE_UNAVAILABLE_MESSAGE,
  failClaimedSecretCommandsForUnsupportedAgent,
  secretDeliveryPreflight,
  type SecretDeliveryPreflightFailureCode,
} from './scriptSecretDelivery';
import {
  builtinNameContextNeeds,
  EXECUTION_PARAMETER_BINDINGS_KEY,
  hasTenantVariableBoundParameters,
  resolveSourcedParameters,
  type ScriptParameterBindingDescriptor,
  type SourcedParameterNameContext,
} from './sourcedParameters';

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
  // `hostname`, `siteId`, and `customFields` are carried for #3409 PR3's
  // sourced parameters: a `deviceCustomField` binding reads `customFields`
  // and the `builtin` source reads device/site/org properties. Nothing in
  // THIS file consumes them yet — widening the projection is deliberately a
  // separate step from adding the resolver, so every call site is already
  // supplying the data before resolution starts depending on it. Every
  // caller either selects whole device rows (scriptExecution.ts,
  // aiToolsScripts.ts via verifyDeviceAccess) or carries a run-level device
  // snapshot that was widened to match (automationRuntime.ts).
  device: Pick<
    typeof devices.$inferSelect,
    'id' | 'orgId' | 'osType' | 'status' | 'agentId' | 'hostname' | 'siteId' | 'customFields'
  >;
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
  // A snapshot preloaded ONCE per fan-out by the caller (#3409 PR2 Task 4) —
  // see tenantVariableResolution.ts. Required only when `source.kind ===
  // 'saved'` and the script content actually contains a {{var.*}} token; the
  // common token-free path never needs one.
  variableScope?: TenantVariableScope;
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
      //
      // Every value here is a QUEUED outcome: the command exists and can
      // still reach the agent. A terminal refusal is never reported on this
      // arm — the claim-time secret gate's outcome is an `ok: false` /
      // 'agent_upgrade_required_recorded' refusal (see below), because every
      // caller branches on `ok` alone and would otherwise report a run that
      // had already been failed as successfully queued.
      deliveryOutcome:
        | 'sent'
        | 'claim_lost'
        | 'decrypt_failed'
        | 'send_failed'
        | 'no_agent';
      executedAt: Date | null;
      // Bound parameter keys the caller supplied a value for (#3409 PR3
      // §2.2). The binding wins authoritatively and the supplied value is
      // dropped — reported rather than rejected, because a stored automation
      // action is validated without consulting the referenced script's
      // definitions and so literally cannot pre-validate against a binding.
      ignoredParameters: string[];
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
        | 'unresolved_variables'
        // A SOURCED PARAMETER could not be resolved for this device (#3409
        // PR3): a required parameter with no source value and no default, or
        // a `tenantVariable` binding whose target is a secret. Deliberately
        // distinct from 'unresolved_variables' above — a parameter-binding
        // failure and a content-token failure are different operational
        // conditions and must stay distinguishable in execution history.
        | 'unresolved_parameters'
        // #3409 PR4c-2 — the three ENQUEUE-time secret-delivery refusals,
        // raised ONLY when the script actually resolved a `tenantSecret`
        // parameter (see services/scriptSecretDelivery.ts for the messages):
        //   'secrets_unsupported_run_as'   — runAs 'user' / a targetSessionId:
        //       the helper IPC carries no environment, so the credential
        //       simply could not arrive.
        //   'secret_delivery_unavailable'  — this server has no active
        //       secret-encryption key, so the envelope cannot be sealed.
        //   'agent_upgrade_required'       — the device agent does not declare
        //       secret-env support and would run the script with the
        //       credential UNSET. The ORDINARY outcome for any pre-PR4b agent.
        // All three are per-device and refuse BEFORE the execution insert, so
        // a refused device leaves NO rows behind and its caller owes it the
        // ordinary per-device failure row.
        | SecretDeliveryPreflightFailureCode
        // The two CLAIM-time refusals from the immediate-send path below.
        // Split from the enqueue codes above because row ownership differs,
        // and `DISPATCH_CODES_ALREADY_RECORDED` (scriptExecution.ts) keys on
        // the code alone:
        //   'agent_upgrade_required_recorded' — the gate returned a verdict
        //       and, in doing so, already drove the command AND the linked
        //       execution row to 'failed' and already spent the batch's
        //       `devicesFailed` slot. The ONLY code a fan-out must record
        //       WITHOUT writing its own failure row. Rare: it needs an agent
        //       downgrade between enqueue and claim. Carries
        //       AGENT_UPGRADE_REQUIRED_MESSAGE, same as the enqueue refusal —
        //       only the bookkeeping differs, not the remediation.
        //   'secret_gate_unavailable'        — the gate FAULTED (its
        //       capability select threw) instead of returning a verdict. We
        //       fail closed, but nothing was written on this path, so it must
        //       stay OUT of DISPATCH_CODES_ALREADY_RECORDED, and its message
        //       must not blame an agent version that may be perfectly current.
        | 'agent_upgrade_required_recorded'
        | 'secret_gate_unavailable';
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
  let content = source.kind === 'saved' ? source.script.content : source.content;
  const runAs = input.runAs ?? (source.kind === 'saved' ? source.script.runAs : 'system');
  const timeoutSeconds = input.timeoutSeconds ?? (source.kind === 'saved' ? source.script.timeoutSeconds : 300);
  const payloadScriptId = source.kind === 'saved' ? source.script.id : source.provenance;

  // #3409 PR2 Task 4: resolve {{var.*}} tokens for this device's org before
  // anything else happens with `content`. `hasVariableTokens` comes first so
  // the common token-free path does no work at all — no scope lookup, no
  // substitution pass. `{kind:'raw'}` is deliberately skipped: an ad-hoc
  // execute_command has no declaring script, so nothing could have been
  // validated at save time (routes/scripts.ts's secret-token rejection only
  // runs against a saved script's content) — its tokens pass through
  // verbatim. This sits BEFORE the script_executions insert below so a
  // failed device leaves no orphan 'pending' row for the caller's per-device
  // failure channel (scriptExecution.ts) to clean up.
  if (source.kind === 'saved' && hasVariableTokens(content)) {
    if (!input.variableScope) {
      throw new Error('variableScope is required to dispatch a script containing {{var.*}} tokens');
    }
    const outcome = substituteTenantVariables(content, resolveForOrg(input.variableScope, device.orgId));
    const failure = describeVariableFailure(outcome);
    if (failure) {
      return { ok: false, code: 'unresolved_variables', error: failure };
    }
    content = outcome.content;
  }

  // #3409 PR3: sourced-parameter resolution. Sits AFTER content substitution
  // and BEFORE the script_executions insert below, for the same reason PR2's
  // substitution does — a device that fails resolution must leave no orphan
  // 'pending' row behind for the reaper to later mislabel 'timeout'.
  //
  // `{kind:'raw'}` (execute_command) is skipped entirely: there is no
  // declaring script, so there are no definitions to bind and nothing to
  // resolve.
  let resolvedParameters: Record<string, string | number | boolean> = parameters as Record<
    string,
    string | number | boolean
  >;
  let parameterBindings: ScriptParameterBindingDescriptor[] = [];
  let ignoredParameters: string[] = [];
  let secretEnv: Record<string, string> = {};
  if (source.kind === 'saved' && Array.isArray(source.script.parameters) && source.script.parameters.length > 0) {
    const definitions = source.script.parameters;
    // Only a tenantVariable binding needs the snapshot; the other three
    // sources read the device row (or the name lookup below), so a script
    // with no such binding never requires a scope — mirroring the
    // content-token gate directly above.
    let variables: Map<string, ResolvedVariable> | undefined;
    // Keys whose row EXISTS for this org but failed to decrypt (#3409 PR4c-1).
    // Loaded from the SAME snapshot and in the same branch as `variables` —
    // the two are read together or not at all. Without it the resolver cannot
    // tell an undecryptable secret from an unset one and reports "no value
    // for required parameter", which sends a tech to create a duplicate
    // variable mid-rotation instead of looking at the encryption keys.
    let unreadableVariableKeys: ReadonlySet<string> | undefined;
    if (hasTenantVariableBoundParameters(definitions)) {
      if (!input.variableScope) {
        throw new Error('variableScope is required to dispatch a script with a tenantVariable-bound parameter');
      }
      variables = resolveForOrg(input.variableScope, device.orgId);
      unreadableVariableKeys = unreadableForOrg(input.variableScope, device.orgId);
    }

    const resolution = resolveSourcedParameters({
      definitions,
      callerParameters: parameters,
      device,
      names: await loadBuiltinNameContext(definitions, device),
      variables,
      unreadableVariableKeys,
      // The script's own ownership tier, read off the row dispatch already
      // holds. `scripts.org_id IS NULL` is partner-wide (or system) — the
      // same expression the org-equality invariant above uses. This is the
      // AUTHORITATIVE input to the "never resolve a secret above your own
      // tier" gate; see ResolveSourcedParametersInput.scriptOwnerScope for
      // why save-time validation cannot stand in for it.
      scriptOwnerScope: source.script.orgId === null ? 'partner' : 'organization',
    });
    if (!resolution.ok) {
      return { ok: false, code: resolution.code, error: resolution.error };
    }
    resolvedParameters = resolution.parameters;
    parameterBindings = resolution.bindings;
    ignoredParameters = resolution.ignoredParameters;
    secretEnv = resolution.secretEnv;
  }

  // #3409 PR4c-2: the enqueue-time secret-delivery gate. Only a script that
  // actually resolved a `tenantSecret` parameter pays for it — `hasSecrets`
  // is known locally here, so the hot path never inspects a payload and never
  // reads the device's capability column.
  //
  // Sits BEFORE the script_executions insert for the same reason PR2's
  // substitution and PR3's resolution do: a refused device must leave no
  // orphan 'pending' row for the reaper to later mislabel 'timeout'.
  const hasSecrets = Object.keys(secretEnv).length > 0;
  if (hasSecrets) {
    const preflight = await secretDeliveryPreflight({
      deviceId: device.id,
      runAs,
      targetSessionId: input.targetSessionId,
    });
    if (!preflight.ok) {
      return { ok: false, code: preflight.code, error: preflight.error };
    }
  }

  // #3826 Wave 4A Task 3: agent principals reach dispatch through the SAME
  // handlers humans use (an `ai_agent` AuthContext's `auth.user.id` is the
  // agent's `ai_agents.id`, not a `users.id` — see
  // services/aiAgents/agentAuthContext.ts). Both `triggeredBy` (inserted
  // below into `script_executions.triggered_by`, FK -> users.id,
  // schema/scripts.ts:126) and `createdBy` (forwarded to queueCommand, whose
  // `device_commands.created_by` is the SAME FK shape) would otherwise die on
  // a 23503 the first time an agent-released run reaches here. Mirrors the
  // shipped `commandQueue.ts:855-889` probe precedent: one indexed PK lookup
  // on whichever id is present, run inside `withSystemDbAccessContext` (same
  // as the precedent) since `users` is an RLS-forced dual-axis table and a
  // contextless read DENIES rather than bypassing — any id that isn't a
  // users row degrades to NULL on both columns rather than aborting the
  // dispatch.
  //
  // Single probe for both columns: every real caller passes the SAME id for
  // triggeredBy and createdBy (or supplies only one — automation's raw
  // command action has no execution row and so no triggeredBy at all), so
  // one lookup on whichever is present settles both writes. `createdBy` is
  // preferred as the probe candidate since it is the one that always reaches
  // queueCommand.
  //
  // #4299: the probe must ESCAPE the caller's context before opening the
  // system one. `withDbAccessContext` short-circuits when a store already
  // exists, so `withSystemDbAccessContext` on its own is a no-op inside a
  // request — the "system" probe silently inherits the caller's scope. Under
  // the org-scoped, user-less context `dbAccessContextFromAuth` builds for an
  // `ai_agent` principal, a partner-level human (`users.org_id IS NULL`)
  // matches NO branch of the RLS SELECT policy on `users` (partner access is
  // not granted to an org-scoped caller, the org branch is skipped on a NULL
  // `org_id`, and `breeze_current_user_id()` is null), so the probe reads zero
  // rows and degrades a REAL human to NULL on both columns. This path is
  // FK-safe, so that damage is silent — no 23503, just attribution quietly
  // lost. `runOutsideDbContext` clears both stores, which is what lets the
  // nested `withSystemDbAccessContext` open a genuinely fresh system-scoped
  // transaction. Mirrors the fix shipped for `resolveCommandCreatedBy` in
  // commandQueue.ts (#4292); note the directly-imported `runOutsideDbContext`
  // is used, never `db.runOutsideDbContext` (the `db` proxy delegates to the
  // active transaction, which has no such method).
  const actorCandidateId = input.createdBy ?? input.triggeredBy ?? null;
  const actorIsRealUser = actorCandidateId
    ? await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          const [userRow] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, actorCandidateId))
            .limit(1);
          return Boolean(userRow);
        }),
      )
    : true;
  const safeTriggeredBy = actorIsRealUser ? input.triggeredBy ?? null : null;
  const safeCreatedBy = actorIsRealUser ? input.createdBy ?? null : null;
  // Attribution for a degraded id survives in the execution record's
  // `parameters` sidecar (below) — never on the users-FK column itself.
  const degradedActorId = actorIsRealUser ? null : actorCandidateId;

  let executionId: string | null = null;
  if (source.kind === 'saved') {
    // Child rows always take the DEVICE's org (partner-wide fan-out rule).
    const [execution] = await db
      .insert(scriptExecutions)
      .values({
        scriptId: source.script.id,
        deviceId: device.id,
        orgId: device.orgId,
        triggeredBy: safeTriggeredBy,
        triggerType: input.triggerType ?? 'manual',
        ...(source.automationRunId ? { automationRunId: source.automationRunId } : {}),
        // #3409 PR3 P4: the CALLER's raw parameters, never the resolved map.
        // A resolved bound value must not be persisted — in PR4 that would
        // mean writing a resolved SECRET into execution history, exactly the
        // leak the out-of-band delivery channel exists to prevent. What IS
        // persisted alongside is an identity-only binding descriptor
        // (`{key, source, variableId?, ownerScope?, version?}`), so history
        // can answer "which variable fed this run" without carrying what it
        // was worth.
        parameters: buildExecutionParameters(parameters, parameterBindings, degradedActorId),
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
    // Payload build lives inside this guarded region (not after it) so a seal
    // failure — #3409 PR4a made the 'script' entry real — also discards the
    // pending execution row instead of orphaning it.
    //
    // The secret envelope's AAD binds the command id, so the id must exist
    // BEFORE encryption. Reserving it here (rather than reading it back from
    // the insert) is what keeps encryption inside this guarded region.
    // Live since PR4c-2: `secretEnv` is set for `tenantSecret` parameters and
    // sealed here into `secretEnvEnvelope`; without one this is a passthrough.
    const reservedCommandId = randomUUID();
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
      // #3409 PR3: the RESOLVED map (caller runtime values + server-resolved
      // bound values) — the only place a resolved value is ever allowed to
      // exist. For a script with no parameter definitions this is the
      // caller's map unchanged, i.e. exactly PR2's behaviour.
      parameters: canonicalizeScriptParameters(resolvedParameters),
      // #3409 PR4c-2: resolved `tenantSecret` values, deliberately OUTSIDE
      // `parameters` (which the agent substitutes into the script text and
      // mirrors as BREEZE_PARAM_*). `encryptSensitivePayloadFields` consumes
      // this key and replaces it with the sealed `secretEnvEnvelope` string,
      // so no plaintext secret is ever stored on the command row. The key is
      // omitted entirely when there are none — the seal path is opt-in.
      ...(hasSecrets ? { secretEnv } : {}),
      timeoutSeconds,
      runAs,
      ...(input.targetSessionId != null ? { targetSessionId: input.targetSessionId } : {}),
    }, { commandId: reservedCommandId, deviceId: device.id });
    stage = 'queueCommand';
    command = await queueCommand(device.id, 'script', payload, safeCreatedBy ?? undefined, {
      commandId: reservedCommandId,
    });
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
  let deliveryOutcome:
    | 'sent'
    | 'claim_lost'
    | 'decrypt_failed'
    | 'send_failed'
    | 'no_agent' = 'no_agent';
  if (device.agentId) {
    const claimed = await claimPendingCommandForDelivery(command.id);
    if (claimed) {
      // #3409 PR4c-2: the immediate-send path claims the command itself and
      // hands it straight to the WS, bypassing
      // `decryptClaimedCommandsForDelivery` — so the claim-time gate has to
      // run HERE too, or a device whose agent lost the capability between the
      // preflight above and this claim would receive the script with the
      // credential unset. Only the secret-bearing path pays for it.
      //
      // A `[]` return means the gate already drove the command AND its
      // execution row terminal: do not send, and do NOT release the claim
      // back to pending (an incapable agent would just re-claim it).
      //
      // The gate's own try/catch covers only its writes — the capability
      // SELECT (and its multi-device contract-violation throw) propagates
      // out of here. Left bare that would escape AFTER
      // `claimPendingCommandForDelivery` already flipped the row to 'sent',
      // 500 the caller, and abort a large fan-out mid-run. So a throw fails
      // CLOSED (never decrypt, never send) and returns a per-device refusal
      // so the fan-out continues — but under its OWN code
      // ('secret_gate_unavailable'), not the capability one: nothing was
      // written on that path, and the agent may be perfectly current. The
      // command row is deliberately LEFT 'sent' with its envelope intact for
      // the stale-command reaper to strip — this path cannot know whether the
      // gate's terminal write landed, and writing over it blind could clobber
      // a row something else already moved.
      // `false` = deliver; a code = refuse with it. Distinct values because
      // the two refusals differ in whether rows were already written.
      let gated: false | 'agent_upgrade_required_recorded' | 'secret_gate_unavailable' = false;
      if (hasSecrets) {
        try {
          const survivors = await failClaimedSecretCommandsForUnsupportedAgent([
            {
              id: command.id,
              type: 'script',
              deviceId: device.id,
              payload,
              executedAt: claimed.executedAt,
            },
          ]);
          gated = survivors.length === 0 ? 'agent_upgrade_required_recorded' : false;
        } catch (gateErr) {
          // ids only — never the payload, sealed or otherwise.
          console.error('[scriptDispatch] secret claim gate threw; refusing delivery', {
            commandId: command.id,
            deviceId: device.id,
            executionId,
            error: gateErr instanceof Error ? gateErr.message : String(gateErr),
          });
          captureException(gateErr);
          // NOT the capability refusal: this branch wrote nothing, and the
          // agent may be perfectly current. A distinct code keeps it out of
          // DISPATCH_CODES_ALREADY_RECORDED (so the device still gets its
          // failure row) and off the "go upgrade your agent" remediation.
          gated = 'secret_gate_unavailable';
        }
      }
      if (gated) {
        return gated === 'agent_upgrade_required_recorded'
          ? { ok: false, code: gated, error: AGENT_UPGRADE_REQUIRED_MESSAGE }
          : { ok: false, code: gated, error: SECRET_GATE_UNAVAILABLE_MESSAGE };
      }
      const deliverable = decryptCommandForDelivery({
        id: command.id,
        type: 'script',
        deviceId: device.id,
        payload,
      });
      const sent = deliverable
        ? sendCommandToAgent(device.agentId, toAgentCommandFrame(deliverable))
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

  return { ok: true, commandId: command.id, executionId, delivered, deliveryOutcome, executedAt, ignoredParameters };
}

// #3826 Wave 4A Task 3: reserved sidecar key for the users-FK probe-and-degrade
// above. Same rationale as EXECUTION_PARAMETER_BINDINGS_KEY (no migration, no
// new column) — `$` can never start a real parameter name, so this can never
// collide with caller-supplied data. Written ONLY when the probe actually
// degraded an id, so a real-user dispatch never gains this key.
const EXECUTION_PARAMETER_ACTOR_KEY = '$actor';

/**
 * The value written to `script_executions.parameters` — the caller's raw
 * parameters, plus the binding descriptors under a reserved `$bindings` key
 * when there are any (#3409 PR3 P4), plus a reserved `$actor` key when the
 * users-FK probe above degraded `triggeredBy`/`createdBy` to NULL (#3826 Wave
 * 4A Task 3) — attribution for the agent that actually ran this survives here
 * instead of on the users-FK column.
 *
 * The descriptors ride INSIDE the existing jsonb rather than in a new sibling
 * column because PR3 ships no migration: `script_executions` carries an
 * `org_id`, so a new column would also have to be classified in
 * `CORE_TENANT_EXPORT_POLICY` (the registration step this repo has shipped
 * bugs on five times), and a `jsonb` column would land in `excludedOpen`
 * anyway. `$` can never start a parameter name
 * (`SCRIPT_PARAMETER_KEY_PATTERN`), so the reserved key cannot collide with a
 * real one; when there are no bindings and no degraded actor, the stored
 * value is byte-identical to what PR2 wrote.
 */
function buildExecutionParameters(
  callerParameters: Record<string, unknown>,
  bindings: ScriptParameterBindingDescriptor[],
  degradedActorId: string | null,
): Record<string, unknown> {
  let result = callerParameters;
  if (bindings.length > 0) {
    result = { ...result, [EXECUTION_PARAMETER_BINDINGS_KEY]: bindings };
  }
  if (degradedActorId) {
    result = {
      ...result,
      [EXECUTION_PARAMETER_ACTOR_KEY]: { actorType: 'ai_agent', actorId: degradedActorId },
    };
  }
  return result;
}

/**
 * Load the two builtin values that are not columns on the device row.
 * `org.id`, `site.id` and `device.hostname` come off the widened device
 * projection for free; only `org.name` / `site.name` cost a query, and
 * {@link builtinNameContextNeeds} keeps both queries off the path for every
 * script that doesn't bind them — which is all of them today.
 *
 * Runs in the caller's ambient DB context deliberately: the caller was
 * already authorized to dispatch to this device, so an org-scoped request
 * transaction can read its own org/site, and the system-context callers
 * (automation worker, AI tools) are unconstrained. No context escape is
 * needed or wanted here.
 */
async function loadBuiltinNameContext(
  definitions: unknown,
  device: Pick<typeof devices.$inferSelect, 'orgId' | 'siteId'>,
): Promise<SourcedParameterNameContext> {
  const needs = builtinNameContextNeeds(definitions);
  if (!needs.orgName && !needs.siteName) return {};

  const context: SourcedParameterNameContext = {};
  if (needs.orgName) {
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);
    context.orgName = org?.name ?? null;
  }
  if (needs.siteName && device.siteId) {
    const [site] = await db
      .select({ name: sites.name })
      .from(sites)
      .where(eq(sites.id, device.siteId))
      .limit(1);
    context.siteName = site?.name ?? null;
  }
  return context;
}
