import { randomUUID } from 'node:crypto';

import type { ScriptAdmissionResult, ScriptTargetAdmission } from '@breeze/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '../db';
import {
  devices,
  scriptExecutionBatches,
  scriptExecutions,
  scripts,
} from '../db/schema';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { canAccessSite, type UserPermissions } from './permissions';
import { dispatchScriptToDevice } from './scriptDispatch';
import { loadTenantVariableScope } from './tenantVariableResolution';
import { scriptNeedsVariableScope } from './sourcedParameters';

type ScriptExecutionAuth = {
  user: { id: string };
  orgId: string | null;
  canAccessOrg: (orgId: string) => boolean;
};

type ExecuteScriptOnDevicesInput = {
  scriptId: string;
  deviceIds: string[];
  parameters?: Record<string, unknown>;
  triggerType?: 'manual' | 'scheduled' | 'alert' | 'policy';
  runAs?: 'system' | 'user';
  targetSessionId?: number;
  auth: ScriptExecutionAuth;
  permissions?: UserPermissions;
};

type ExecuteScriptOnDevicesFailure = {
  ok: false;
  status: 404;
  error: string;
};

type ExecuteScriptOnDevicesSuccess = {
  ok: true;
  admission: ScriptAdmissionResult;
  script: typeof scripts.$inferSelect;
  auditOrgId: string | null;
  triggerType: 'manual' | 'scheduled' | 'alert' | 'policy';
  runAs: string;
  ignoredParameters: string[];
};

export type ExecuteScriptOnDevicesResult = ExecuteScriptOnDevicesSuccess | ExecuteScriptOnDevicesFailure;

/**
 * Dispatch failure codes whose `script_executions` row and `devicesFailed`
 * batch increment were ALREADY written before `dispatchScriptToDevice`
 * returned — so this fan-out must record the refusal in admission but must
 * NOT write its own duplicate row or double-spend the batch slot.
 *
 * Exactly one code qualifies: the claim-time secret gate's refusal (#3409
 * PR4c-2). `failClaimedSecretCommandsForUnsupportedAgent` drives the command
 * AND its linked execution row to 'failed' and bumps the batch itself before
 * dispatch turns that into an 'agent_upgrade_required_recorded' refusal.
 *
 * Membership must be argued per code, not inferred from the message. The
 * three neighbours that look similar and are NOT members:
 *
 * - 'agent_upgrade_required' — the ENQUEUE preflight, which refuses before
 *   any row exists. It is the ORDINARY outcome for any pre-PR4b agent, and
 *   it originally shared a code with the claim-time gate: on 10 devices with
 *   3 old agents the batch showed 7 accounted rows and
 *   `devicesCompleted + devicesFailed >= devicesTargeted` never held, so the
 *   batch could never finalize. That is why the claim-time path carries a
 *   code of its own.
 * - 'secret_gate_unavailable' — the claim gate FAULTED rather than returning
 *   a verdict, so it wrote nothing.
 * - 'secrets_unsupported_run_as' / 'secret_delivery_unavailable' — enqueue
 *   refusals, likewise nothing written.
 *
 * A named set rather than an inline `===` so a future code is added here
 * deliberately, with that ownership question answered.
 */
const DISPATCH_CODES_ALREADY_RECORDED: ReadonlySet<string> = new Set([
  'agent_upgrade_required_recorded',
]);

function ensureOrgAccess(orgId: string, auth: Pick<ScriptExecutionAuth, 'canAccessOrg'>) {
  return auth.canAccessOrg(orgId);
}

async function getScriptWithOrgCheck(scriptId: string, auth: Pick<ScriptExecutionAuth, 'canAccessOrg'>) {
  const [script] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
    .limit(1);

  if (!script) return null;
  if (script.isSystem) return script;
  if (script.orgId && !ensureOrgAccess(script.orgId, auth)) return null;
  return script;
}

function canAccessDeviceSite(siteId: string | null | undefined, userPerms: UserPermissions | undefined): boolean {
  if (!userPerms?.allowedSiteIds) return true;
  return typeof siteId === 'string' && canAccessSite(userPerms, siteId);
}

function resolveScriptAuditOrgId(
  auth: { orgId: string | null },
  scriptOrgId?: string | null,
  deviceOrgId?: string | null,
): string | null {
  return scriptOrgId ?? deviceOrgId ?? auth.orgId ?? null;
}

export async function executeScriptOnDevices(input: ExecuteScriptOnDevicesInput): Promise<ExecuteScriptOnDevicesResult> {
  const script = await getScriptWithOrgCheck(input.scriptId, input.auth);
  if (!script) {
    return { ok: false, status: 404, error: 'Script not found' };
  }

  const requestedDeviceIds = [...new Set(input.deviceIds)];
  const deviceRecords = await db
    .select()
    .from(devices)
    .where(inArray(devices.id, requestedDeviceIds));

  const deviceById = new Map(deviceRecords.map((device) => [device.id, device]));
  const targetById = new Map<string, ScriptTargetAdmission>();
  const executableDevices: typeof deviceRecords = [];

  for (const requestedDeviceId of requestedDeviceIds) {
    const device = deviceById.get(requestedDeviceId);
    let target: ScriptTargetAdmission;
    if (!device || !ensureOrgAccess(device.orgId, input.auth)) {
      target = { requestedDeviceId, admission: 'denied', reasonCode: 'not_found_or_inaccessible' };
    } else if (!canAccessDeviceSite(device.siteId, input.permissions)) {
      target = { requestedDeviceId, admission: 'denied', reasonCode: 'site_access_denied' };
    } else if (script.orgId !== null && script.orgId !== device.orgId) {
      target = { requestedDeviceId, admission: 'denied', reasonCode: 'script_org_mismatch' };
    } else if (!script.osTypes.includes(device.osType)) {
      target = { requestedDeviceId, admission: 'excluded', reasonCode: 'os_incompatible' };
    } else if (device.status === 'decommissioned') {
      target = { requestedDeviceId, admission: 'excluded', reasonCode: 'device_decommissioned' };
    } else {
      target = { requestedDeviceId, admission: 'admitted' };
      executableDevices.push(device);
    }
    targetById.set(requestedDeviceId, target);
  }

  const maintenanceEligibleDevices = [...executableDevices];
  executableDevices.length = 0;
  for (const device of maintenanceEligibleDevices) {
    const maintenanceStatus = await checkDeviceMaintenanceWindow(device.id);
    if (maintenanceStatus.active && maintenanceStatus.suppressScripts) {
      targetById.set(device.id, {
        requestedDeviceId: device.id,
        admission: 'suppressed',
        reasonCode: 'maintenance_suppressed',
      });
    } else {
      executableDevices.push(device);
    }
  }

  const triggerType = input.triggerType ?? 'manual';
  const parameters = input.parameters ?? {};
  const runAs = input.runAs ?? script.runAs;

  // Preload ONCE per fan-out (#3409 PR2 Task 4), never per device — one
  // snapshot covers every org in this batch's executable device set.
  //
  // Gated on the script actually needing a scope. Without the gate EVERY
  // script run — the overwhelming majority of which reference no variable at
  // all — would escape the request transaction via runOutsideDbContext and
  // take a second connection to run a join that is then never consulted.
  // loadTenantVariableScope short-circuits on an empty org list without
  // querying, so passing [] is the no-op path.
  //
  // #3409 PR3 P1: the gate is `scriptNeedsVariableScope`, not
  // `hasVariableTokens(content)` — a `tenantVariable`-bound parameter lives
  // in `scripts.parameters`, not in the content, and a content-only gate
  // would hand dispatch an EMPTY scope for it, making every bound parameter
  // resolve as "no value set" for a variable that exists.
  const variableScope = await loadTenantVariableScope(
    scriptNeedsVariableScope(script) ? [...new Set(executableDevices.map((d) => d.orgId))] : []
  );

  // A multi-org run (partner/system script fanned out across orgs) must not
  // stamp every batch row with the first device's org — split one batch per
  // org instead. A single-org, single-device run keeps today's no-batch
  // behavior; a single-org multi-device run keeps today's one-batch
  // behavior. Once more than one org is targeted, every org's group gets its
  // own batch (even an org with just one device in that run) so no execution
  // is misattributed to another org's batch.
  const devicesByOrg = new Map<string, typeof executableDevices>();
  for (const device of executableDevices) {
    const group = devicesByOrg.get(device.orgId);
    if (group) {
      group.push(device);
    } else {
      devicesByOrg.set(device.orgId, [device]);
    }
  }
  const multiOrg = devicesByOrg.size > 1;

  const batchIdByOrg = new Map<string, string>();
  const createdBatchIds: string[] = [];
  for (const [orgId, orgDevices] of devicesByOrg) {
    if (orgDevices.length <= 1 && !multiOrg) continue;
    const [batch] = await db
      .insert(scriptExecutionBatches)
      .values({
        scriptId: input.scriptId,
        orgId,
        triggeredBy: input.auth.user.id,
        triggerType,
        parameters,
        devicesTargeted: orgDevices.length,
        status: 'pending',
      })
      .returning();
    if (!batch) {
      throw new Error('Failed to create batch');
    }
    batchIdByOrg.set(orgId, batch.id);
    createdBatchIds.push(batch.id);
  }

  // A Set, not an array: see `ignoredParameters` on the success type. Insertion
  // order is preserved so the reported order matches definition order.
  const ignoredParameters = new Set<string>();
  // This loop itself is sequential/awaited and therefore bounded, but
  // queueCommand (inside dispatchScriptToDevice) fires an un-awaited,
  // fire-and-forget audit transaction PER DEVICE for 'script' commands
  // (AUDITED_COMMANDS in commandQueue.ts) that this loop cannot see or wait
  // on. That's the actual unbounded fan-out risk — a large batch launches
  // that many concurrent transactions against a pool sized for far fewer
  // while this request also holds a connection (pool-starvation shape).
  // The real mitigation is the `.max(500)` cap on `deviceIds` in
  // executeScriptSchema (routes/scripts.ts) — do not raise that cap without
  // also addressing this fan-out, and do not "fix" it by restructuring
  // queueCommand's audit dispatch out from under this loop.
  for (const device of executableDevices) {
    const dispatch = await dispatchScriptToDevice({
      device,
      source: { kind: 'saved', script },
      parameters,
      triggerType,
      triggeredBy: input.auth.user.id,
      createdBy: input.auth.user.id,
      runAs,
      targetSessionId: input.targetSessionId,
      batchId: batchIdByOrg.get(device.orgId) ?? null,
      variableScope,
    });
    if (!dispatch.ok) {
      // Three-way branch on the code, by ROW OWNERSHIP:
      //
      //   1. 'insert_failed' — queueCommand/the execution insert itself broke.
      //      A programming error, not a per-device condition: throw and abort
      //      the run rather than recording N identical device failures.
      //   2. a DISPATCH_CODES_ALREADY_RECORDED code — a per-device condition
      //      whose failure row and batch slot the dispatch core's own gate
      //      already wrote. Report it, write nothing.
      //   3. everything else ('unresolved_variables' from PR2's content
      //      substitution, 'unresolved_parameters' from PR3's sourced
      //      parameters, the enqueue secret refusals, and the device-state
      //      codes) — a per-device condition that owns no rows yet, so this
      //      loop writes the failure row and spends the batch slot. It must
      //      not truncate the rest of the fan-out; `dispatchManagerInstalls`
      //      (softwareDeployment.ts) is the pattern this mirrors — named
      //      rather than cited by line number so the reference cannot rot.
      if (dispatch.code === 'insert_failed') {
        throw new Error(dispatch.error);
      }
      // The device still lands in the admission result — the operator must see it — but
      // its row and batch slot are already spent by whoever owns this code.
      if (DISPATCH_CODES_ALREADY_RECORDED.has(dispatch.code)) {
        targetById.set(device.id, {
          requestedDeviceId: device.id,
          admission: 'excluded',
          reasonCode: normalizeDispatchReasonCode(dispatch.code),
          ...(batchIdByOrg.get(device.orgId) ? { batchId: batchIdByOrg.get(device.orgId) } : {}),
        });
        continue;
      }
      await db.insert(scriptExecutions).values({
        scriptId: input.scriptId,
        deviceId: device.id,
        // Child rows always take the DEVICE's org (partner-wide fan-out
        // rule) — never the script's, which may be null/partner-wide.
        orgId: device.orgId,
        triggeredBy: input.auth.user.id,
        triggerType,
        parameters,
        status: 'failed',
        errorMessage: dispatch.error,
        completedAt: new Date(),
      });
      const batchId = batchIdByOrg.get(device.orgId);
      if (batchId) {
        await db
          .update(scriptExecutionBatches)
          .set({ devicesFailed: sql`${scriptExecutionBatches.devicesFailed} + 1` })
          .where(eq(scriptExecutionBatches.id, batchId));
      }
      targetById.set(device.id, {
        requestedDeviceId: device.id,
        admission: 'excluded',
        reasonCode: normalizeDispatchReasonCode(dispatch.code),
        ...(batchId ? { batchId } : {}),
      });
      continue;
    }
    for (const key of dispatch.ignoredParameters) {
      ignoredParameters.add(key);
    }
    targetById.set(device.id, {
      requestedDeviceId: device.id,
      admission: 'admitted',
      ...(dispatch.executionId ? { executionId: dispatch.executionId } : {}),
      commandId: dispatch.commandId,
      ...(batchIdByOrg.get(device.orgId) ? { batchId: batchIdByOrg.get(device.orgId) } : {}),
    });
  }

  if (createdBatchIds.length > 0) {
    await db
      .update(scriptExecutionBatches)
      .set({ status: 'queued' })
      .where(inArray(scriptExecutionBatches.id, createdBatchIds));
  }

  const targets = requestedDeviceIds.map((deviceId) => targetById.get(deviceId)!);
  const admittedCount = targets.filter((target) => target.admission === 'admitted').length;
  const status: ScriptAdmissionResult['status'] = admittedCount === 0
    ? 'rejected'
    : admittedCount === targets.length
      ? 'queued'
      : 'partially_queued';

  return {
    ok: true,
    admission: { requestId: randomUUID(), status, targets },
    script,
    auditOrgId: resolveScriptAuditOrgId(input.auth, script.orgId, executableDevices[0]?.orgId ?? null),
    triggerType,
    runAs,
    ignoredParameters: [...ignoredParameters],
  };
}

function normalizeDispatchReasonCode(code: string): string {
  if (code === 'org_mismatch') return 'script_org_mismatch';
  if (code === 'os_mismatch') return 'os_incompatible';
  if (code === 'device_decommissioned') return 'device_decommissioned';
  return code;
}
