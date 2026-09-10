import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { backupJobs, backupSnapshots, devices, hypervVms } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { resolveAllBackupAssignedDevices, resolveBackupConfigForDevice, effectiveBackupModes } from '../../services/featureConfigResolver';
import { backupCommandResultSchema } from './resultSchemas';
import { describeZodIssues } from '../../lib/zodIssues';
import {
  applyBackupCommandResultToJob,
  markBackupJobFailedIfInFlight,
} from '../../services/backupResultPersistence';
import {
  resolveBackupWriteCommandDestination,
  resolveBackupProviderConfig,
  resolveBackupDestinationError,
} from '../../services/backupProviderConfig';
import {
  hypervBackupSchema,
  hypervRestoreSchema,
  hypervCheckpointSchema,
  hypervVmStateSchema,
} from './schemas';
import {
  authorizeRouteResilienceResources,
  resolveRouteAuthorizedDeviceIds,
} from './resilienceAuthorization';
import { parseAgentJsonStdout } from '../../services/agentCommandStdout';
import { applyBackupStartedAck, isBackupQueuedAck, isBackupStartedAck } from '../../services/backupProgress';

const deviceIdParamSchema = z.object({
  deviceId: z.string().guid(),
});

const vmIdParamSchema = z.object({
  deviceId: z.string().guid(),
  vmId: z.string().guid(),
});

export const hypervRoutes = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────

// ── GET /hyperv/vms — List all Hyper-V VMs (org-wide) ──────────────

hypervRoutes.get('/vms', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.query('deviceId');
  const state = c.req.query('state');
  const authorizedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);
  if (deviceId && authorizedDeviceIds && !authorizedDeviceIds.includes(deviceId)) {
    return c.json({ error: 'site_access_denied' }, 403);
  }
  if (authorizedDeviceIds && authorizedDeviceIds.length === 0) {
    return c.json({ vms: [], total: 0 });
  }

  let query = db
    .select()
    .from(hypervVms)
    .where(and(
      eq(hypervVms.orgId, orgId),
      authorizedDeviceIds ? inArray(hypervVms.deviceId, authorizedDeviceIds) : undefined,
    ));

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
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'device', id: deviceId, role: 'source' },
    ], 'read');
    if (!authorization.ok) return authorization.response;

    const vms = await db
      .select()
      .from(hypervVms)
      .where(
        and(eq(hypervVms.orgId, orgId), eq(hypervVms.deviceId, deviceId))
      );

    return c.json({ vms, total: vms.length });
  }
);

// ── GET /hyperv/discovery-targets — Hyper-V-protected Windows hosts ────────

hypervRoutes.get(
  '/discovery-targets',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const authorizedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);
    if (authorizedDeviceIds && authorizedDeviceIds.length === 0) {
      return c.json({ data: [] });
    }
    const assignedDevices = await resolveAllBackupAssignedDevices(orgId);
    const targetDeviceIds = assignedDevices
      .filter((entry) => entry.configId && effectiveBackupModes(entry).includes('hyperv'))
      .map((entry) => entry.deviceId);
    const visibleTargetDeviceIds = authorizedDeviceIds
      ? targetDeviceIds.filter((deviceId) => authorizedDeviceIds.includes(deviceId))
      : targetDeviceIds;

    if (visibleTargetDeviceIds.length === 0) {
      return c.json({ data: [] });
    }

    const rows = await db
      .select({
        id: devices.id,
        displayName: devices.displayName,
        hostname: devices.hostname,
        osType: devices.osType,
        status: devices.status,
      })
      .from(devices)
      .where(and(
        eq(devices.orgId, orgId),
        eq(devices.osType, 'windows'),
        inArray(devices.id, visibleTargetDeviceIds),
      ));

    const data = rows
      .sort((a, b) => {
        const left = (a.displayName ?? a.hostname ?? a.id).toLowerCase();
        const right = (b.displayName ?? b.hostname ?? b.id).toLowerCase();
        return left.localeCompare(right);
      })
      .map((row) => ({
        ...row,
        eligible: row.status === 'online',
      }));

    return c.json({ data });
  }
);

// ── POST /hyperv/discover/:deviceId — Trigger VM discovery ──────────

hypervRoutes.post(
  '/discover/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'device', id: deviceId, role: 'target' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

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

    // Parse discovered VMs and upsert into the database. D20-A: the manual
    // "parse once, unwrap again if it's still a string" here is exactly what
    // parseAgentJsonStdout does — replaced with the shared implementation so
    // every forwarded-helper route (mssql.ts too) tolerates a double-encoded
    // stdout from any agent still on a pre-D20-B build the same way.
    let discoveredVMs: any[] = [];
    try {
      if (result.stdout) {
        const parsed = parseAgentJsonStdout(result.stdout);
        discoveredVMs = Array.isArray(parsed) ? parsed : [];
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
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', hypervBackupSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'device', id: payload.deviceId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

    const resolvedConfig = await resolveBackupConfigForDevice(payload.deviceId);
    if (!resolvedConfig?.configId) {
      return c.json({ error: 'A provider-backed backup configuration is required on this device' }, 400);
    }

    // D20b item A: the helper only builds a manager from the command payload
    // when it has no agent.yaml backup config (mgr == nil — the normal state
    // for every policy-managed device); without provider/providerConfig here
    // the helper fails every on-demand hyperv_backup with "backup not
    // configured on this device", even though a provider-backed config
    // resolved just above. Same builder backupWorker.ts's
    // prepareBackupDispatchTargets uses for a profile-scheduled run.
    const destinationResult = await resolveBackupWriteCommandDestination(resolvedConfig.configId, orgId);
    if (!destinationResult.ok) {
      return c.json(
        { error: destinationResult.message, reason: destinationResult.reason },
        destinationResult.reason === 'encryption_unsupported' ? 422 : 400
      );
    }
    const { destination } = destinationResult;

    const [backupJob] = await db
      .insert(backupJobs)
      .values({
        orgId,
        configId: resolvedConfig.configId,
        featureLinkId: resolvedConfig.featureLinkId,
        deviceId: payload.deviceId,
        status: 'pending',
        type: 'manual',
        backupType: 'application',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (!backupJob) {
      return c.json({ error: 'Failed to create backup job' }, 500);
    }

    const result = await executeCommand(
      payload.deviceId,
      CommandTypes.HYPERV_BACKUP,
      {
        // D20-E: lets agentWs.ts's processCommandResult (and
        // handleProviderBackedBackupResult) correlate the REAL terminal
        // result — which arrives as a second, unsolicited command_result
        // frame after a queue-admission ack — back to this backup_jobs row.
        jobId: backupJob.id,
        configId: resolvedConfig.configId,
        provider: destination.provider,
        providerConfig: destination.providerConfig,
        storageEncryption: destination.storageEncryption,
        vmName: payload.vmName,
        consistencyType: payload.consistencyType,
      },
      { userId: auth?.user?.id, timeoutMs: 600000 } // 10 min for large VMs
    );

    let snapshotDbId: string | null = null;
    let providerSnapshotId: string | null = null;
    let parsedData: unknown = null;
    try {
      // D20-A: tolerates a double-encoded stdout from an agent still on a
      // pre-D20-B build.
      parsedData = parseAgentJsonStdout(result.stdout);

      // D20-C: a queued/starting agent acks admission with
      // {"queued":true}/{"started":true} instead of the real outcome — that
      // is not a parse failure, and must not fail the job. Report it as still
      // running; the real result is applied later when it actually arrives
      // (agentWs.ts processCommandResult / handleProviderBackedBackupResult).
      if (isBackupQueuedAck(parsedData) || isBackupStartedAck(parsedData)) {
        const queued = isBackupQueuedAck(parsedData);
        await applyBackupStartedAck({ jobId: backupJob.id, deviceId: payload.deviceId, queued });
        return c.json({
          data: { backupJobId: backupJob.id, status: 'running', queued },
        }, 202);
      }

      const parsedBackup = backupCommandResultSchema.safeParse(parsedData);
      if (!parsedBackup.success) {
        throw new Error(describeZodIssues(parsedBackup.error));
      }
      const persisted = await applyBackupCommandResultToJob({
        jobId: backupJob.id,
        orgId,
        deviceId: payload.deviceId,
        resultStatus: result.status,
        // Forwarded even though hyperv never reports `partial` today: this
        // schema now carries the agent's own status, and a path that parses it
        // but drops it is a trap the moment the provider learns to report one.
        agentStatus: parsedBackup.data.status,
        result: {
          ...parsedBackup.data,
          error: result.error,
        },
      });
      snapshotDbId = persisted.snapshotDbId;
      providerSnapshotId = persisted.providerSnapshotId;
    } catch (error) {
      await markBackupJobFailedIfInFlight(
        backupJob.id,
        error instanceof Error ? error.message : 'Failed to persist Hyper-V backup result',
      );
      if (result.status === 'completed') {
        return c.json(
          { error: error instanceof Error ? error.message : 'Failed to persist Hyper-V backup result' },
          500
        );
      }
    }

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

    return c.json({
      data: {
        ...(parsedData && typeof parsedData === 'object' ? parsedData : { raw: result.stdout ?? null }),
        backupJobId: backupJob.id,
        snapshotDbId,
        snapshotId: providerSnapshotId,
      },
    });
  }
);

// ── POST /hyperv/restore — Trigger VM restore (import) ──────────────

hypervRoutes.post(
  '/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', hypervRestoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: payload.snapshotId, role: 'source' },
      { kind: 'device', id: payload.deviceId, role: 'target' },
    ], 'restore');
    if (!authorization.ok) return authorization.response;

    const [snapshot] = await db
      .select({
        id: backupSnapshots.id,
        providerSnapshotId: backupSnapshots.snapshotId,
        metadata: backupSnapshots.metadata,
        configId: backupSnapshots.configId,
      })
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.id, payload.snapshotId),
          eq(backupSnapshots.orgId, orgId)
        )
      )
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const metadata =
      snapshot.metadata && typeof snapshot.metadata === 'object' && !Array.isArray(snapshot.metadata)
        ? snapshot.metadata as Record<string, unknown>
        : {};
    if (metadata.backupKind !== 'hyperv_export') {
      return c.json({ error: 'Snapshot is not a Hyper-V export artifact' }, 400);
    }

    // D20b item D: the helper builds its read provider from the RESTORE
    // command's own payload (restoreProviderForCommand), the same way
    // backup_restore already does (routes/backup/restore.ts) — mirroring the
    // destination the BACKUP command wrote this snapshot to, not whatever the
    // device's CURRENT config happens to be.
    const backupProviderConfig = snapshot.configId
      ? await resolveBackupProviderConfig(snapshot.configId, orgId)
      : null;
    if (!backupProviderConfig) {
      const { reason, message } = resolveBackupDestinationError(snapshot.configId);
      return c.json({ error: message, reason }, 422);
    }

    const result = await executeCommand(
      payload.deviceId,
      CommandTypes.HYPERV_RESTORE,
      {
        snapshotId: snapshot.providerSnapshotId,
        vmName: payload.vmName,
        generateNewId: payload.generateNewId,
        provider: backupProviderConfig.provider,
        providerConfig: backupProviderConfig.providerConfig,
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
        snapshotId: snapshot.id,
        vmName: payload.vmName,
      },
    });

    try {
      const data = result.stdout ? parseAgentJsonStdout(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /hyperv/checkpoints/:deviceId/:vmId — Manage checkpoints ───

hypervRoutes.post(
  '/checkpoints/:deviceId/:vmId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', vmIdParamSchema),
  zValidator('json', hypervCheckpointSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId, vmId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'device', id: deviceId, role: 'target' },
      { kind: 'vm', id: vmId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

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
      const data = result.stdout ? parseAgentJsonStdout(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /hyperv/vm-state/:deviceId/:vmId — Change VM power state ───

hypervRoutes.post(
  '/vm-state/:deviceId/:vmId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', vmIdParamSchema),
  zValidator('json', hypervVmStateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId, vmId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'device', id: deviceId, role: 'target' },
      { kind: 'vm', id: vmId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

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
        targetState: payload.state,
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
      const data = result.stdout ? parseAgentJsonStdout(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);
