import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  deviceCommands,
  deviceDisks,
  securityScans,
  securityThreats,
  securityStatus
} from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { queueCommandForExecution } from '../../services/commandQueue';
import {
  getFilesystemScanState,
  mergeFilesystemAnalysisPayload,
  parseFilesystemAnalysisStdout,
  readCheckpointPendingDirectories,
  readHotDirectories,
  saveFilesystemSnapshot,
  upsertFilesystemScanState,
} from '../../services/filesystemAnalysis';
import {
  commandResultSchema,
  securityCommandTypes,
  securityStatusIngestSchema,
  filesystemAnalysisCommandType,
  parseEnvBoundedNumber
} from './schemas';
import type { SecurityStatusPayload } from './schemas';
import {
  isObject,
  asString,
  asBoolean,
  asInt,
  isUuid,
  normalizeProvider,
  normalizeSeverity,
  upsertSecurityStatusForDevice,
} from './helpers';
import type { AgentContext } from './helpers';

export const commandResultsRoutes = new Hono();

const filesystemAutoResumeMaxRuns = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_AUTO_RESUME_MAX_RUNS,
  200,
  1,
  5000
);

function parseResultJson(stdout: string | undefined): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    return isObject(parsed) ? parsed : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[agents] Failed to parse command result JSON:', message, stdout?.slice(0, 500));
    return undefined;
  }
}

function getSecurityStatusFromResult(resultData: Record<string, unknown> | undefined): SecurityStatusPayload | undefined {
  if (!resultData) return undefined;

  const nested = isObject(resultData.status) ? resultData.status : undefined;
  const candidate = nested ?? resultData;
  const parsed = securityStatusIngestSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data;
}

async function updateThreatStatusForAction(command: typeof deviceCommands.$inferSelect): Promise<void> {
  const payload = isObject(command.payload) ? command.payload : {};
  const threatId = payload.threatId;
  const threatPath = asString(payload.path);

  let targetId: string | undefined;
  if (isUuid(threatId)) {
    targetId = threatId;
  } else if (threatPath) {
    const [threat] = await db
      .select({ id: securityThreats.id })
      .from(securityThreats)
      .where(and(eq(securityThreats.deviceId, command.deviceId), eq(securityThreats.filePath, threatPath)))
      .orderBy(desc(securityThreats.detectedAt))
      .limit(1);
    targetId = threat?.id;
  }

  if (!targetId) return;

  const now = new Date();
  if (command.type === securityCommandTypes.quarantine) {
    await db
      .update(securityThreats)
      .set({ status: 'quarantined', resolvedAt: null, resolvedBy: null })
      .where(eq(securityThreats.id, targetId));
    return;
  }

  if (command.type === securityCommandTypes.remove) {
    await db
      .update(securityThreats)
      .set({ status: 'removed', resolvedAt: now, resolvedBy: 'agent' })
      .where(eq(securityThreats.id, targetId));
    return;
  }

  if (command.type === securityCommandTypes.restore) {
    await db
      .update(securityThreats)
      .set({ status: 'allowed', resolvedAt: now, resolvedBy: 'agent' })
      .where(eq(securityThreats.id, targetId));
  }
}

async function handleSecurityCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  const resultJson = parseResultJson(resultData.stdout);
  const parsedStatus = getSecurityStatusFromResult(resultJson);
  if (parsedStatus) {
    await upsertSecurityStatusForDevice(command.deviceId, parsedStatus);
  }

  if (command.type === securityCommandTypes.collectStatus) {
    return;
  }

  if (command.type === securityCommandTypes.scan) {
    const payload = isObject(command.payload) ? command.payload : {};
    const scanType = asString(resultJson?.scanType) ?? asString(payload.scanType) ?? 'quick';
    const scanRecordId = asString(resultJson?.scanRecordId) ?? asString(payload.scanRecordId);
    const threatsValue = Array.isArray(resultJson?.threats) ? resultJson.threats : [];
    const threatsFoundRaw = resultJson?.threatsFound;
    const threatsFound = typeof threatsFoundRaw === 'number'
      ? Math.max(0, Math.floor(threatsFoundRaw))
      : threatsValue.length;
    const completedAt = new Date();
    const durationSeconds = Math.max(0, Math.round(resultData.durationMs / 1000));

    let existingScan: { id: string } | undefined;
    if (isUuid(scanRecordId)) {
      [existingScan] = await db
        .select({ id: securityScans.id })
        .from(securityScans)
        .where(and(eq(securityScans.id, scanRecordId), eq(securityScans.deviceId, command.deviceId)))
        .limit(1);
    }

    if (existingScan) {
      await db
        .update(securityScans)
        .set({
          status: resultData.status === 'completed' ? 'completed' : 'failed',
          completedAt,
          duration: durationSeconds,
          threatsFound
        })
        .where(eq(securityScans.id, existingScan.id));
    } else {
      await db.insert(securityScans).values({
        ...(isUuid(scanRecordId) ? { id: scanRecordId } : {}),
        deviceId: command.deviceId,
        scanType,
        status: resultData.status === 'completed' ? 'completed' : 'failed',
        startedAt: command.createdAt ?? new Date(),
        completedAt,
        threatsFound,
        duration: durationSeconds
      });
    }

    if (resultData.status === 'completed' && threatsValue.length > 0) {
      const provider = normalizeProvider(parsedStatus?.provider);
      const inserts: Array<typeof securityThreats.$inferInsert> = [];

      for (const threat of threatsValue) {
        if (!isObject(threat)) continue;
        inserts.push({
          deviceId: command.deviceId,
          provider,
          threatName: asString(threat.name) ?? asString(threat.threatName) ?? 'Unknown Threat',
          threatType: asString(threat.type) ?? asString(threat.threatType) ?? asString(threat.category) ?? null,
          severity: normalizeSeverity(threat.severity),
          status: 'detected',
          filePath: asString(threat.path) ?? asString(threat.filePath) ?? null,
          processName: asString(threat.processName) ?? null,
          detectedAt: completedAt,
          details: threat
        });
      }

      if (inserts.length > 0) {
        await db.insert(securityThreats).values(inserts);
      }
    }

    return;
  }

  if (
    command.type === securityCommandTypes.quarantine ||
    command.type === securityCommandTypes.remove ||
    command.type === securityCommandTypes.restore
  ) {
    if (resultData.status === 'completed') {
      await updateThreatStatusForAction(command);
    }
  }
}

function extractHotDirectoriesFromSnapshotPayload(payload: Record<string, unknown>, limit: number): string[] {
  const rootPath = asString(payload.path);
  const rawDirs = Array.isArray(payload.topLargestDirectories) ? payload.topLargestDirectories : [];
  const paths = rawDirs
    .map((entry) => {
      if (!isObject(entry)) return null;
      return asString(entry.path) ?? null;
    })
    .filter((path): path is string => path !== null && path !== rootPath);
  return Array.from(new Set(paths)).slice(0, limit);
}

async function handleFilesystemAnalysisCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  if (resultData.status !== 'completed') {
    return;
  }

  const payload = isObject(command.payload) ? command.payload : {};
  const trigger = asString(payload.trigger);
  const snapshotTrigger = trigger === 'threshold' ? 'threshold' : 'on_demand';
  const scanMode = asString(payload.scanMode) === 'incremental' ? 'incremental' : 'baseline';

  const parsed = parseFilesystemAnalysisStdout(resultData.stdout ?? '');
  if (Object.keys(parsed).length === 0) {
    return;
  }

  const currentState = await getFilesystemScanState(command.deviceId);
  const existingAggregate = isObject(currentState?.aggregate) ? currentState.aggregate : {};
  const mergedPayload = scanMode === 'baseline'
    ? mergeFilesystemAnalysisPayload(existingAggregate, parsed)
    : parsed;
  const pendingDirs = readCheckpointPendingDirectories(mergedPayload.checkpoint, 50_000);
  const hasCheckpoint = scanMode === 'baseline' && pendingDirs.length > 0;
  const snapshotPayload = hasCheckpoint
    ? {
      ...mergedPayload,
      partial: true,
      reason: `checkpoint pending ${pendingDirs.length} directories`,
      checkpoint: { pendingDirs },
      scanMode,
    }
    : {
      ...mergedPayload,
      scanMode,
    };

  await saveFilesystemSnapshot(command.deviceId, snapshotTrigger, snapshotPayload);

  const [disk] = await db
    .select({ usedPercent: deviceDisks.usedPercent })
    .from(deviceDisks)
    .where(eq(deviceDisks.deviceId, command.deviceId))
    .limit(1);
  const currentDiskUsedPercent = typeof disk?.usedPercent === 'number' ? disk.usedPercent : null;

  const hotFromRun = extractHotDirectoriesFromSnapshotPayload(snapshotPayload, 24);
  const mergedHotDirectories = Array.from(
    new Set([
      ...hotFromRun,
      ...readHotDirectories(currentState?.hotDirectories, 24),
    ])
  ).slice(0, 24);

  const snapshotIsPartial = 'partial' in snapshotPayload ? Boolean(snapshotPayload.partial) : false;
  const baselineCompleted = scanMode === 'baseline' && pendingDirs.length === 0 && !snapshotIsPartial;
  await upsertFilesystemScanState(command.deviceId, {
    lastRunMode: scanMode,
    lastBaselineCompletedAt: baselineCompleted
      ? new Date()
      : currentState?.lastBaselineCompletedAt ?? null,
    lastDiskUsedPercent: currentDiskUsedPercent ?? currentState?.lastDiskUsedPercent ?? null,
    checkpoint: hasCheckpoint ? { pendingDirs } : {},
    aggregate: scanMode === 'baseline' && !baselineCompleted ? mergedPayload : {},
    hotDirectories: mergedHotDirectories,
  });

  if (!hasCheckpoint || scanMode !== 'baseline') {
    return;
  }

  const autoContinue = asBoolean(payload.autoContinue, true);
  if (!autoContinue) {
    return;
  }

  const resumeAttempt = Math.max(0, asInt(payload.resumeAttempt, 0));
  if (resumeAttempt >= filesystemAutoResumeMaxRuns) {
    return;
  }

  const [inFlightScan] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, command.deviceId),
        eq(deviceCommands.type, filesystemAnalysisCommandType),
        sql`${deviceCommands.status} IN ('pending', 'sent')`
      )
    )
    .limit(1);

  if (inFlightScan) {
    return;
  }

  const nextPayload: Record<string, unknown> = {
    ...(isObject(payload) ? payload : {}),
    scanMode: 'baseline',
    checkpoint: { pendingDirs },
    autoContinue: true,
    resumeAttempt: resumeAttempt + 1,
  };
  delete nextPayload.targetDirectories;

  const queued = await queueCommandForExecution(
    command.deviceId,
    filesystemAnalysisCommandType,
    nextPayload,
    {
      userId: command.createdBy ?? undefined,
      preferHeartbeat: false,
    }
  );
  if (queued.command) {
    return;
  }

  await db.insert(deviceCommands).values({
    deviceId: command.deviceId,
    type: filesystemAnalysisCommandType,
    payload: nextPayload,
    status: 'pending',
    createdBy: command.createdBy,
  });
}

commandResultsRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('json', commandResultSchema),
  async (c) => {
    const commandId = c.req.param('commandId');
    const data = c.req.valid('json');
    const agent = c.get('agent') as AgentContext | undefined;
    const agentId = c.req.param('id');

    if (!agent?.deviceId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    // Ephemeral commands (terminal/desktop) have non-UUID IDs and no DB record.
    if (commandId.startsWith('term-') || commandId.startsWith('desk-')) {
      return c.json({ success: true });
    }

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.deviceId, agent.deviceId)
        )
      )
      .limit(1);

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    await db
      .update(deviceCommands)
      .set({
        status: data.status === 'completed' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          status: data.status,
          exitCode: data.exitCode,
          stdout: data.stdout,
          stderr: data.stderr,
          durationMs: data.durationMs,
          error: data.error
        }
      })
      .where(eq(deviceCommands.id, commandId));

    const warnings: string[] = [];

    if (
      command.type === securityCommandTypes.collectStatus ||
      command.type === securityCommandTypes.scan ||
      command.type === securityCommandTypes.quarantine ||
      command.type === securityCommandTypes.remove ||
      command.type === securityCommandTypes.restore
    ) {
      try {
        await handleSecurityCommandResult(command, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agents] security command post-processing failed for ${commandId}:`, err);
        warnings.push(`Security post-processing failed: ${message}`);
      }
    }

    if (command.type === filesystemAnalysisCommandType) {
      try {
        await handleFilesystemAnalysisCommandResult(command, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agents] filesystem analysis post-processing failed for ${commandId}:`, err);
        warnings.push(`Filesystem analysis post-processing failed: ${message}`);
      }
    }

    writeAuditEvent(c, {
      orgId: agent?.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: commandId,
      details: {
        commandType: command.type,
        status: data.status,
        exitCode: data.exitCode ?? null,
      },
      result: data.status === 'completed' ? 'success' : 'failure',
    });

    return c.json({ success: true, ...(warnings.length > 0 ? { warnings } : {}) });
  }
);
