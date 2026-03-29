import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { devices, hypervVms } from '../../db/schema';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from './helpers';
import {
  hypervBackupSchema,
  hypervRestoreSchema,
  hypervCheckpointSchema,
  hypervVmStateSchema,
} from './schemas';

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

const vmIdParamSchema = z.object({
  deviceId: z.string().uuid(),
  vmId: z.string().uuid(),
});

export const hypervRoutes = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────

async function verifyDevice(deviceId: string, orgId: string) {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device || device.orgId !== orgId) {
    return null;
  }
  return device;
}

// ── GET /hyperv/vms — List all Hyper-V VMs (org-wide) ──────────────

hypervRoutes.get('/vms', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.query('deviceId');
  const state = c.req.query('state');

  let query = db
    .select()
    .from(hypervVms)
    .where(eq(hypervVms.orgId, orgId));

  const rows = await query;

  let filtered = rows;
  if (deviceId) {
    filtered = filtered.filter((r) => r.deviceId === deviceId);
  }
  if (state) {
    filtered = filtered.filter((r) => r.state === state);
  }

  return c.json({ vms: filtered, total: filtered.length });
});

// ── GET /hyperv/vms/:deviceId — VMs on a specific host ──────────────

hypervRoutes.get(
  '/vms/:deviceId',
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId } = c.req.valid('param');

    const device = await verifyDevice(deviceId, orgId);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const vms = await db
      .select()
      .from(hypervVms)
      .where(
        and(eq(hypervVms.orgId, orgId), eq(hypervVms.deviceId, deviceId))
      );

    return c.json({ vms, total: vms.length });
  }
);

// ── POST /hyperv/discover/:deviceId — Trigger VM discovery ──────────

hypervRoutes.post(
  '/discover/:deviceId',
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId } = c.req.valid('param');

    const device = await verifyDevice(deviceId, orgId);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await executeCommand(
      deviceId,
      CommandTypes.HYPERV_DISCOVER,
      {},
      { userId: auth?.user?.id, timeoutMs: 60000 }
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'Failed to discover Hyper-V VMs' },
        500
      );
    }

    // Parse discovered VMs and upsert into the database.
    let discoveredVMs: any[] = [];
    try {
      if (result.stdout) {
        const parsed = JSON.parse(result.stdout);
        discoveredVMs = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      }
    } catch {
      return c.json({ data: result.stdout });
    }

    if (Array.isArray(discoveredVMs)) {
      for (const vm of discoveredVMs) {
        await db
          .insert(hypervVms)
          .values({
            orgId,
            deviceId,
            vmId: vm.id || '',
            vmName: vm.name || 'unknown',
            generation: vm.generation || 1,
            state: vm.state || 'unknown',
            vhdPaths: vm.vhdPaths || [],
            memoryMb: vm.memoryMb || null,
            processorCount: vm.processorCount || null,
            rctEnabled: vm.rctEnabled || false,
            hasPassthroughDisks: vm.hasPassthrough || false,
            checkpoints: vm.checkpoints || [],
            notes: vm.notes || null,
            lastDiscoveredAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [hypervVms.deviceId, hypervVms.vmId],
            set: {
              vmName: vm.name || 'unknown',
              generation: vm.generation || 1,
              state: vm.state || 'unknown',
              vhdPaths: vm.vhdPaths || [],
              memoryMb: vm.memoryMb || null,
              processorCount: vm.processorCount || null,
              rctEnabled: vm.rctEnabled || false,
              hasPassthroughDisks: vm.hasPassthrough || false,
              checkpoints: vm.checkpoints || [],
              notes: vm.notes || null,
              lastDiscoveredAt: new Date(),
              updatedAt: new Date(),
            },
          });
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'hyperv.discover',
      resourceType: 'device',
      resourceId: deviceId,
      details: { vmCount: discoveredVMs.length },
    });

    return c.json({ vms: discoveredVMs, total: discoveredVMs.length });
  }
);

// ── POST /hyperv/backup — Trigger VM backup (export) ────────────────

hypervRoutes.post(
  '/backup',
  zValidator('json', hypervBackupSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    const device = await verifyDevice(payload.deviceId, orgId);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await executeCommand(
      payload.deviceId,
      CommandTypes.HYPERV_BACKUP,
      {
        vmName: payload.vmName,
        exportPath: payload.exportPath,
        consistencyType: payload.consistencyType,
      },
      { userId: auth?.user?.id, timeoutMs: 600000 } // 10 min for large VMs
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'Hyper-V backup failed' },
        500
      );
    }

    writeRouteAudit(c, {
      orgId,
      action: 'hyperv.backup',
      resourceType: 'device',
      resourceId: payload.deviceId,
      details: {
        vmName: payload.vmName,
        consistencyType: payload.consistencyType,
      },
    });

    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /hyperv/restore — Trigger VM restore (import) ──────────────

hypervRoutes.post(
  '/restore',
  zValidator('json', hypervRestoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    const device = await verifyDevice(payload.deviceId, orgId);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await executeCommand(
      payload.deviceId,
      CommandTypes.HYPERV_RESTORE,
      {
        exportPath: payload.exportPath,
        vmName: payload.vmName,
        generateNewId: payload.generateNewId,
      },
      { userId: auth?.user?.id, timeoutMs: 600000 }
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'Hyper-V restore failed' },
        500
      );
    }

    writeRouteAudit(c, {
      orgId,
      action: 'hyperv.restore',
      resourceType: 'device',
      resourceId: payload.deviceId,
      details: {
        exportPath: payload.exportPath,
        vmName: payload.vmName,
      },
    });

    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /hyperv/checkpoints/:deviceId/:vmId — Manage checkpoints ───

hypervRoutes.post(
  '/checkpoints/:deviceId/:vmId',
  zValidator('param', vmIdParamSchema),
  zValidator('json', hypervCheckpointSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId, vmId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const device = await verifyDevice(deviceId, orgId);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Look up the VM name from our records.
    const [vm] = await db
      .select({ vmName: hypervVms.vmName })
      .from(hypervVms)
      .where(
        and(
          eq(hypervVms.deviceId, deviceId),
          eq(hypervVms.id, vmId),
          eq(hypervVms.orgId, orgId)
        )
      )
      .limit(1);

    if (!vm) {
      return c.json({ error: 'VM not found' }, 404);
    }

    const result = await executeCommand(
      deviceId,
      CommandTypes.HYPERV_CHECKPOINT,
      {
        vmName: vm.vmName,
        action: payload.action,
        checkpointName: payload.checkpointName || '',
      },
      { userId: auth?.user?.id, timeoutMs: 120000 }
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'Checkpoint operation failed' },
        500
      );
    }

    writeRouteAudit(c, {
      orgId,
      action: `hyperv.checkpoint.${payload.action}`,
      resourceType: 'hyperv_vm',
      resourceId: vmId,
      details: {
        deviceId,
        vmName: vm.vmName,
        checkpointAction: payload.action,
        checkpointName: payload.checkpointName,
      },
    });

    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /hyperv/vm-state/:deviceId/:vmId — Change VM power state ───

hypervRoutes.post(
  '/vm-state/:deviceId/:vmId',
  zValidator('param', vmIdParamSchema),
  zValidator('json', hypervVmStateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId, vmId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const device = await verifyDevice(deviceId, orgId);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Look up the VM name.
    const [vm] = await db
      .select({ vmName: hypervVms.vmName })
      .from(hypervVms)
      .where(
        and(
          eq(hypervVms.deviceId, deviceId),
          eq(hypervVms.id, vmId),
          eq(hypervVms.orgId, orgId)
        )
      )
      .limit(1);

    if (!vm) {
      return c.json({ error: 'VM not found' }, 404);
    }

    const result = await executeCommand(
      deviceId,
      CommandTypes.HYPERV_VM_STATE,
      {
        vmName: vm.vmName,
        state: payload.state,
      },
      { userId: auth?.user?.id, timeoutMs: 60000 }
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'VM state change failed' },
        500
      );
    }

    writeRouteAudit(c, {
      orgId,
      action: `hyperv.vm_state.${payload.state}`,
      resourceType: 'hyperv_vm',
      resourceId: vmId,
      details: {
        deviceId,
        vmName: vm.vmName,
        targetState: payload.state,
      },
    });

    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);
