import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../db';
import {
  deviceCommands,
  devices,
  scriptExecutionBatches,
  scriptExecutions,
  scripts,
} from '../db/schema';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { canAccessSite, type UserPermissions } from './permissions';
import { sendCommandToAgent } from '../routes/agentWs';

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

  let batchId: string | null = null;
  if (executableDevices.length > 1) {
    const batchOrgId = executableDevices[0]!.orgId;
    const [batch] = await db
      .insert(scriptExecutionBatches)
      .values({
        scriptId: input.scriptId,
        orgId: batchOrgId,
        triggeredBy: input.auth.user.id,
        triggerType,
        parameters,
        devicesTargeted: executableDevices.length,
        status: 'pending',
      })
      .returning();
    if (!batch) {
      throw new Error('Failed to create batch');
    }
    batchId = batch.id;
  }

  const executions: Array<{ executionId: string; deviceId: string; commandId: string }> = [];
  for (const device of executableDevices) {
    const [execution] = await db
      .insert(scriptExecutions)
      .values({
        scriptId: input.scriptId,
        deviceId: device.id,
        orgId: device.orgId,
        triggeredBy: input.auth.user.id,
        triggerType,
        parameters,
        status: 'pending',
      })
      .returning();

    if (!execution) {
      throw new Error('Failed to create execution');
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'script',
        payload: {
          scriptId: input.scriptId,
          executionId: execution.id,
          batchId,
          language: script.language,
          content: script.content,
          parameters,
          timeoutSeconds: script.timeoutSeconds,
          runAs,
        },
        status: 'pending',
        createdBy: input.auth.user.id,
      })
      .returning();

    if (!command) {
      throw new Error('Failed to create command');
    }

    if (device.agentId) {
      const claimed = await claimPendingCommandForDelivery(command.id);
      if (claimed) {
        const sent = sendCommandToAgent(device.agentId, {
          id: command.id,
          type: 'script',
          payload: command.payload as Record<string, unknown>,
        });
        if (sent) {
          await db
            .update(scriptExecutions)
            .set({ status: 'running', startedAt: claimed.executedAt })
            .where(eq(scriptExecutions.id, execution.id));
        } else {
          await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
        }
      }
    }

    executions.push({
      executionId: execution.id,
      deviceId: device.id,
      commandId: command.id,
    });
  }

  if (batchId) {
    await db
      .update(scriptExecutionBatches)
      .set({ status: 'queued' })
      .where(eq(scriptExecutionBatches.id, batchId));
  }

  return {
    ok: true,
    batchId,
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
