import { and, eq, inArray, isNull } from 'drizzle-orm';

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
      // Pre-checks above (org access, os filter, decommissioned filter) make
      // these unreachable for this caller; treat as the insert failures the
      // old code threw on.
      throw new Error(dispatch.error);
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
    batchId: createdBatchIds[0] ?? null,
    batchIds: createdBatchIds,
    scriptId: input.scriptId,
    script,
    devicesTargeted: executableDevices.length,
    maintenanceSuppressedDeviceIds,
    executions,
    status: 'queued',
    triggerType,
    runAs,
    auditOrgId: resolveScriptAuditOrgId(input.auth, script.orgId, executableDevices[0]?.orgId ?? null),
  };
}
