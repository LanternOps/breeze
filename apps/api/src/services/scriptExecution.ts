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
  status: 400 | 403 | 404 | 409;
  error: string;
  maintenanceSuppressedDeviceIds?: string[];
};

type ExecuteScriptOnDevicesSuccess = {
  ok: true;
  batchId: string | null;
  batchIds: string[];
  scriptId: string;
  script: typeof scripts.$inferSelect;
  devicesTargeted: number;
  maintenanceSuppressedDeviceIds: string[];
  executions: Array<{ executionId: string; deviceId: string; commandId: string }>;
  // Per-device dispatch failures (e.g. unresolved {{var.*}} tokens). These
  // devices are excluded from `executions` but still counted in
  // `devicesTargeted` — they were targeted, just failed to dispatch. Each one
  // gets its own 'failed' script_executions row (see the dispatch loop below)
  // so `devicesTargeted` never outlives the rows a caller can find.
  failures: Array<{ deviceId: string; code: string; error: string }>;
  status: 'queued';
  triggerType: 'manual' | 'scheduled' | 'alert' | 'policy';
  runAs: string;
  auditOrgId: string | null;
};

export type ExecuteScriptOnDevicesResult = ExecuteScriptOnDevicesSuccess | ExecuteScriptOnDevicesFailure;

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

  const deviceRecords = await db
    .select()
    .from(devices)
    .where(inArray(devices.id, input.deviceIds));

  if (deviceRecords.length === 0) {
    return { ok: false, status: 400, error: 'No valid devices found' };
  }

  const validDevices: typeof deviceRecords = [];
  const siteDeniedDeviceIds: string[] = [];
  for (const device of deviceRecords) {
    if (!ensureOrgAccess(device.orgId, input.auth)) continue;
    // Org-equality invariant (mirrors playbooks.ts): a system/org-less script
    // (orgId === null) is universally runnable, but a non-null script org must
    // match the target device's org. Without this, a multi-org caller can run
    // one org's script content on another org's devices even though both
    // canAccessOrg checks pass. Treat a mismatch like an inaccessible device:
    // exclude it from the executable set rather than failing the whole batch.
    if (script.orgId !== null && script.orgId !== device.orgId) continue;
    if (!canAccessDeviceSite(device.siteId, input.permissions)) {
      siteDeniedDeviceIds.push(device.id);
      continue;
    }
    if (script.osTypes.includes(device.osType) && device.status !== 'decommissioned') {
      validDevices.push(device);
    }
  }

  if (siteDeniedDeviceIds.length > 0) {
    return { ok: false, status: 403, error: 'Access to one or more device sites denied' };
  }

  if (validDevices.length === 0) {
    return { ok: false, status: 400, error: 'No accessible or compatible devices found' };
  }

  const maintenanceSuppressedDeviceIds: string[] = [];
  const executableDevices: typeof validDevices = [];
  for (const device of validDevices) {
    const maintenanceStatus = await checkDeviceMaintenanceWindow(device.id);
    if (maintenanceStatus.active && maintenanceStatus.suppressScripts) {
      maintenanceSuppressedDeviceIds.push(device.id);
    } else {
      executableDevices.push(device);
    }
  }

  if (executableDevices.length === 0) {
    return {
      ok: false,
      status: 409,
      error: 'All target devices are in a maintenance window with script execution suppressed',
      maintenanceSuppressedDeviceIds,
    };
  }

  const triggerType = input.triggerType ?? 'manual';
  const parameters = input.parameters ?? {};
  const runAs = input.runAs ?? script.runAs;

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

  const executions: Array<{ executionId: string; deviceId: string; commandId: string }> = [];
  const failures: Array<{ deviceId: string; code: string; error: string }> = [];
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
    });
    if (!dispatch.ok) {
      // 'insert_failed' means queueCommand/the execution insert itself broke
      // — a programming error, not a per-device condition. Every other code
      // (today: 'unresolved_variables', once Task 4 wires resolution in) is a
      // condition specific to this device and must not truncate the rest of
      // the fan-out — see softwareDeployment.ts:399-414 for the pattern this
      // mirrors.
      if (dispatch.code === 'insert_failed') {
        throw new Error(dispatch.error);
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
      failures.push({ deviceId: device.id, code: dispatch.code, error: dispatch.error });
      continue;
    }
    executions.push({
      executionId: dispatch.executionId!,
      deviceId: device.id,
      commandId: dispatch.commandId,
    });
  }

  if (createdBatchIds.length > 0) {
    await db
      .update(scriptExecutionBatches)
      .set({ status: 'queued' })
      .where(inArray(scriptExecutionBatches.id, createdBatchIds));
  }

  return {
    ok: true,
    // `batchId` is a legacy scalar convenience for the common single-batch
    // case. In a multi-org run there is no single batch that represents the
    // whole run — createdBatchIds[0] would silently pick an arbitrary org's
    // batch, and a consumer polling just that id would track only a slice of
    // the run. Prefer absent-and-loud over misleadingly partial: `batchId` is
    // only populated when exactly one batch was created. `batchIds` (below)
    // always carries the complete list and is what multi-batch callers must
    // use.
    batchId: createdBatchIds.length === 1 ? createdBatchIds[0]! : null,
    batchIds: createdBatchIds,
    scriptId: input.scriptId,
    script,
    devicesTargeted: executableDevices.length,
    maintenanceSuppressedDeviceIds,
    executions,
    failures,
    status: 'queued',
    triggerType,
    runAs,
    auditOrgId: resolveScriptAuditOrgId(input.auth, script.orgId, executableDevices[0]?.orgId ?? null),
  };
}
