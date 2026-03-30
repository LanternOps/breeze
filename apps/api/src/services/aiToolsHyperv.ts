/**
 * AI Hyper-V Backup Tools
 *
 * 6 Hyper-V tools for listing VMs, inspecting VM details, and dispatching
 * VM state, backup, restore, and checkpoint operations.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import { devices, hypervVms } from '../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CommandTypes, queueCommandForExecution } from './commandQueue';

type HypervHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: HypervHandler): HypervHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[hyperv:${toolName}]`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

function clampLimit(value: unknown, fallback = 25, max = 100): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

async function loadVmWithAccess(vmId: string, auth: AuthContext) {
  const vmConditions: SQL[] = [eq(hypervVms.id, vmId)];
  const vc = orgWhere(auth, hypervVms.orgId);
  if (vc) vmConditions.push(vc);

  const [vm] = await db
    .select({
      id: hypervVms.id,
      orgId: hypervVms.orgId,
      deviceId: hypervVms.deviceId,
      vmId: hypervVms.vmId,
      vmName: hypervVms.vmName,
      state: hypervVms.state,
    })
    .from(hypervVms)
    .where(and(...vmConditions))
    .limit(1);

  return vm ?? null;
}

// ============================================
// Register all Hyper-V tools into the aiTools Map
// ============================================

export function registerHypervTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_hyperv_vms — List discovered Hyper-V VMs
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_hyperv_vms',
      description: 'List discovered Hyper-V virtual machines in the accessible organization scope.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Filter to a specific Hyper-V host device UUID' },
          state: { type: 'string', description: 'Filter by VM state' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_hyperv_vms', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, hypervVms.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.deviceId === 'string') conditions.push(eq(hypervVms.deviceId, input.deviceId));
      if (typeof input.state === 'string') conditions.push(eq(hypervVms.state, input.state));

      const limit = clampLimit(input.limit);
      const rows = await db
        .select({
          id: hypervVms.id,
          deviceId: hypervVms.deviceId,
          hostname: devices.hostname,
          vmId: hypervVms.vmId,
          vmName: hypervVms.vmName,
          generation: hypervVms.generation,
          state: hypervVms.state,
          memoryMb: hypervVms.memoryMb,
          processorCount: hypervVms.processorCount,
          rctEnabled: hypervVms.rctEnabled,
          hasPassthroughDisks: hypervVms.hasPassthroughDisks,
          checkpoints: hypervVms.checkpoints,
          lastDiscoveredAt: hypervVms.lastDiscoveredAt,
          updatedAt: hypervVms.updatedAt,
        })
        .from(hypervVms)
        .leftJoin(devices, eq(hypervVms.deviceId, devices.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(hypervVms.updatedAt))
        .limit(limit);

      const vms = rows.map((row) => ({
        ...row,
        checkpoints: Array.isArray(row.checkpoints) ? row.checkpoints : [],
        checkpointCount: Array.isArray(row.checkpoints) ? row.checkpoints.length : 0,
      }));

      return JSON.stringify({ vms, showing: vms.length });
    }),
  });

  // ============================================
  // 2. get_hyperv_vm_details — Full details for one VM
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_hyperv_vm_details',
      description: 'Get detailed Hyper-V VM information for a specific VM record.',
      input_schema: {
        type: 'object' as const,
        properties: {
          vmId: { type: 'string', description: 'Hyper-V VM record UUID (required)' },
        },
        required: ['vmId'],
      },
    },
    handler: safeHandler('get_hyperv_vm_details', async (input, auth) => {
      const vmId = input.vmId as string;
      if (!vmId) return JSON.stringify({ error: 'vmId is required' });

      const vmConditions: SQL[] = [eq(hypervVms.id, vmId)];
      const vc = orgWhere(auth, hypervVms.orgId);
      if (vc) vmConditions.push(vc);

      const [vm] = await db
        .select({
          id: hypervVms.id,
          deviceId: hypervVms.deviceId,
          hostname: devices.hostname,
          deviceStatus: devices.status,
          vmId: hypervVms.vmId,
          vmName: hypervVms.vmName,
          generation: hypervVms.generation,
          state: hypervVms.state,
          vhdPaths: hypervVms.vhdPaths,
          memoryMb: hypervVms.memoryMb,
          processorCount: hypervVms.processorCount,
          rctEnabled: hypervVms.rctEnabled,
          hasPassthroughDisks: hypervVms.hasPassthroughDisks,
          checkpoints: hypervVms.checkpoints,
          notes: hypervVms.notes,
          lastDiscoveredAt: hypervVms.lastDiscoveredAt,
          createdAt: hypervVms.createdAt,
          updatedAt: hypervVms.updatedAt,
        })
        .from(hypervVms)
        .leftJoin(devices, eq(hypervVms.deviceId, devices.id))
        .where(and(...vmConditions))
        .limit(1);

      if (!vm) return JSON.stringify({ error: 'VM not found or access denied' });

      return JSON.stringify({
        ...vm,
        vhdPaths: Array.isArray(vm.vhdPaths) ? vm.vhdPaths : [],
        checkpoints: Array.isArray(vm.checkpoints) ? vm.checkpoints : [],
      });
    }),
  });

  // ============================================
  // 3. manage_hyperv_vm — Queue VM power-state command
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'manage_hyperv_vm',
      description: 'Dispatch a Hyper-V VM state command such as start, stop, pause, or resume.',
      input_schema: {
        type: 'object' as const,
        properties: {
          vmId: { type: 'string', description: 'Hyper-V VM record UUID (required)' },
          action: {
            type: 'string',
            enum: ['start', 'stop', 'force_stop', 'pause', 'resume', 'save'],
            description: 'Requested VM state transition',
          },
        },
        required: ['vmId', 'action'],
      },
    },
    handler: safeHandler('manage_hyperv_vm', async (input, auth) => {
      const vmId = input.vmId as string;
      const action = input.action as string;
      if (!vmId || !action) return JSON.stringify({ error: 'vmId and action are required' });

      const vm = await loadVmWithAccess(vmId, auth);
      if (!vm) return JSON.stringify({ error: 'VM not found or access denied' });

      const { command, error } = await queueCommandForExecution(
        vm.deviceId,
        CommandTypes.HYPERV_VM_STATE,
        { vmName: vm.vmName, state: action },
        { userId: auth.user?.id }
      );

      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        status: command?.status,
        vmId: vm.id,
        vmName: vm.vmName,
        deviceId: vm.deviceId,
        requestedState: action,
      });
    }),
  });

  // ============================================
  // 4. trigger_hyperv_backup — Queue VM backup command
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'trigger_hyperv_backup',
      description: 'Dispatch a Hyper-V VM backup command for a specific VM.',
      input_schema: {
        type: 'object' as const,
        properties: {
          vmId: { type: 'string', description: 'Hyper-V VM record UUID (required)' },
          exportPath: { type: 'string', description: 'Export path for the VM backup (required)' },
          consistencyType: {
            type: 'string',
            enum: ['application', 'crash'],
            description: 'Consistency mode for the backup',
          },
        },
        required: ['vmId', 'exportPath'],
      },
    },
    handler: safeHandler('trigger_hyperv_backup', async (input, auth) => {
      const vmId = input.vmId as string;
      const exportPath = input.exportPath as string;
      const consistencyType = (input.consistencyType as string) ?? 'application';
      if (!vmId || !exportPath) return JSON.stringify({ error: 'vmId and exportPath are required' });

      const vm = await loadVmWithAccess(vmId, auth);
      if (!vm) return JSON.stringify({ error: 'VM not found or access denied' });

      const { command, error } = await queueCommandForExecution(
        vm.deviceId,
        CommandTypes.HYPERV_BACKUP,
        {
          vmName: vm.vmName,
          exportPath,
          consistencyType,
        },
        { userId: auth.user?.id }
      );

      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        status: command?.status,
        vmId: vm.id,
        vmName: vm.vmName,
        deviceId: vm.deviceId,
        exportPath,
        consistencyType,
      });
    }),
  });

  // ============================================
  // 5. restore_hyperv_vm — Queue VM restore command
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'restore_hyperv_vm',
      description: 'Dispatch a Hyper-V restore/import command to a host device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Target Hyper-V host device UUID (required)' },
          exportPath: { type: 'string', description: 'Export path to restore from (required)' },
          vmName: { type: 'string', description: 'Optional VM name override' },
          generateNewId: { type: 'boolean', description: 'Generate a new VM ID during import' },
        },
        required: ['deviceId', 'exportPath'],
      },
    },
    handler: safeHandler('restore_hyperv_vm', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const exportPath = input.exportPath as string;
      if (!deviceId || !exportPath) return JSON.stringify({ error: 'deviceId and exportPath are required' });

      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      const { command, error } = await queueCommandForExecution(
        deviceId,
        CommandTypes.HYPERV_RESTORE,
        {
          exportPath,
          vmName: typeof input.vmName === 'string' ? input.vmName : undefined,
          generateNewId:
            typeof input.generateNewId === 'boolean'
              ? input.generateNewId
              : true,
        },
        { userId: auth.user?.id }
      );

      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        status: command?.status,
        deviceId,
        exportPath,
      });
    }),
  });

  // ============================================
  // 6. manage_hyperv_checkpoints — Queue checkpoint action
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'manage_hyperv_checkpoints',
      description: 'Dispatch a Hyper-V checkpoint create, delete, or apply command for a specific VM.',
      input_schema: {
        type: 'object' as const,
        properties: {
          vmId: { type: 'string', description: 'Hyper-V VM record UUID (required)' },
          action: {
            type: 'string',
            enum: ['create', 'delete', 'apply'],
            description: 'Checkpoint action to perform',
          },
          checkpointName: { type: 'string', description: 'Checkpoint name when applicable' },
        },
        required: ['vmId', 'action'],
      },
    },
    handler: safeHandler('manage_hyperv_checkpoints', async (input, auth) => {
      const vmId = input.vmId as string;
      const action = input.action as string;
      if (!vmId || !action) return JSON.stringify({ error: 'vmId and action are required' });

      const vm = await loadVmWithAccess(vmId, auth);
      if (!vm) return JSON.stringify({ error: 'VM not found or access denied' });

      const { command, error } = await queueCommandForExecution(
        vm.deviceId,
        CommandTypes.HYPERV_CHECKPOINT,
        {
          vmName: vm.vmName,
          action,
          checkpointName: typeof input.checkpointName === 'string' ? input.checkpointName : '',
        },
        { userId: auth.user?.id }
      );

      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        status: command?.status,
        vmId: vm.id,
        vmName: vm.vmName,
        deviceId: vm.deviceId,
        action,
      });
    }),
  });
}
