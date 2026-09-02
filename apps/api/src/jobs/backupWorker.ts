/**
 * Backup Worker
 *
 * BullMQ worker that orchestrates backup jobs:
 * - check-schedules: Polls config policy backup assignments, creates jobs when due
 * - dispatch-backup: Sends backup_run command to agent via WebSocket
 * - process-results: Updates job/snapshot rows from agent result payload
 */

import { Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshots,
  backupConfigs,
  devices,
  configurationPolicies,
  organizations,
  configPolicyFeatureLinks,
  configPolicyBackupSettings,
  hypervVms,
  sqlInstances,
} from '../db/schema';
import { recoveryTokens } from '../db/schema/recoveryTokens';
import { eq, ne, and, sql, isNull, lt, inArray } from 'drizzle-orm';
import { resolveAllBackupAssignedDevices } from '../services/featureConfigResolver';
import { getBullMQConnection } from '../services/redis';
import { dispatchCommandToAgent, isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import type { AgentCommand } from '../routes/agentWs';
import {
  cleanupExpiredSnapshots,
  sweepUnreferencedBackupObjects,
} from './backupRetention';
import * as backupEnqueue from './backupEnqueue';
import { resolveBackupStorageEncryptionPlan } from '../services/backupEncryption';
import { backupCommandResultSchema } from '../routes/backup/resultSchemas';
import { describeZodIssues } from '../lib/zodIssues';
import { getDueOccurrenceKey } from '../routes/backup/helpers';
import { applyBackupCommandResultToJob } from '../services/backupResultPersistence';
import { markBackupJobFailedIfInFlight } from '../services/backupResultPersistence';
import { createScheduledBackupJobIfAbsent } from '../services/backupJobCreation';
import { recordDispatchedExpectation } from '../services/agentWorkExpectation';
import { attachWorkerObservability } from './workerObservability';
import { captureException } from '../services/sentry';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import {
  backupQueueJobDataSchema,
  type BackupQueueJobData,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';
import { jobSchedule } from './scheduleRegistry';

// Re-export enqueue functions for backward compatibility
export const getBackupQueue = backupEnqueue.getBackupQueue;
export const enqueueBackupDispatch = backupEnqueue.enqueueBackupDispatch;
export const enqueueBackupResults = backupEnqueue.enqueueBackupResults;

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};
const BACKUP_QUEUE = 'backup';

// ── Job data types ────────────────────────────────────────────────────────────

type CheckSchedulesJobData = Extract<BackupQueueJobData, { type: 'check-schedules' }>;
type ExpireRecoveryTokensJobData = Extract<BackupQueueJobData, { type: 'expire-recovery-tokens' }>;
type CleanupExpiredSnapshotsJobData = Extract<BackupQueueJobData, { type: 'cleanup-expired-snapshots' }>;
type DispatchBackupJobData = Extract<BackupQueueJobData, { type: 'dispatch-backup' }>;
type ProcessResultsJobData = Extract<BackupQueueJobData, { type: 'process-results' }>;

// ── Worker ────────────────────────────────────────────────────────────────────

function createBackupWorker(): Worker<BackupQueueJobData> {
  return new Worker<BackupQueueJobData>(
    BACKUP_QUEUE,
    async (job: Job<BackupQueueJobData>) => {
      const data = parseQueueJobData(BACKUP_QUEUE, job, backupQueueJobDataSchema);
      // dispatch-backup is handled OUTSIDE the blanket context below (#1105):
      // it does Redis/WS I/O via the agentCommandRelay facade
      // (isAgentConnectedAnywhere, recordDispatchedExpectation,
      // dispatchCommandToAgent — the latter's ack wait is a poll loop up to
      // RELAY_DELIVERY_DEADLINE_MS), and processDispatchBackup manages its own
      // short-lived system DB contexts around just its reads/writes so no
      // pooled connection sits idle-in-transaction across that I/O.
      if (data.type === 'dispatch-backup') {
        assertQueueJobName(BACKUP_QUEUE, job, 'dispatch-backup');
        return await processDispatchBackup(data);
      }
      return runWithSystemDbAccess(async () => {
        switch (data.type) {
          case 'check-schedules':
            assertQueueJobName(BACKUP_QUEUE, job, 'check-schedules');
            return await processCheckSchedules();
          case 'expire-recovery-tokens':
            assertQueueJobName(BACKUP_QUEUE, job, 'expire-recovery-tokens');
            return await processExpireRecoveryTokens();
          case 'cleanup-expired-snapshots':
            assertQueueJobName(BACKUP_QUEUE, job, 'cleanup-expired-snapshots');
            return await processCleanupExpiredSnapshots();
          case 'process-results':
            assertQueueJobName(BACKUP_QUEUE, job, 'process-results');
            return await processResults(data);
          default:
            throw new Error(
              `Unknown job type: ${(data as { type: string }).type}`
            );
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

// ── check-schedules ───────────────────────────────────────────────────────────

type PolicySchedule = {
  frequency?: 'daily' | 'weekly' | 'monthly';
  time?: string;
  timezone?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
};

const SCHEDULE_LOOKBACK_MINUTES = 5;
const BACKUP_REPEATABLE_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:backup:repeatable',
};

async function processCheckSchedules(): Promise<{ enqueued: number }> {
  const now = new Date();

  // 1. Find all org IDs with active backup config policies
  const orgRows = await db
    .selectDistinct({ orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'backup')
      )
    )
    .where(eq(configurationPolicies.status, 'active'));

  // 1b. Partner-wide backup policies (org_id NULL) cover every org under
  // their partner — enumerate those orgs too, or partner-linked backup
  // silently never schedules (the classic partner fan-out no-op).
  const partnerRows = await db
    .selectDistinct({ partnerId: configurationPolicies.partnerId })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'backup')
      )
    )
    .where(and(eq(configurationPolicies.status, 'active'), isNull(configurationPolicies.orgId)));
  const partnerIds = partnerRows
    .map((row) => row.partnerId)
    .filter((id): id is string => !!id);
  // Quick Support exclusion: the hidden per-partner 'quick_support' org holds
  // ephemeral devices — a stranger's personal machine borrowed for one
  // ~20-minute session. It sits under the partner like any other org and stays
  // inside technicians' accessibleOrgIds for RLS reasons, so this partner->org
  // fan-out is NOT filtered for us. Backing up a stranger's home PC to the
  // MSP's storage is a data-protection incident, not a feature.
  const partnerOrgRows = partnerIds.length > 0
    ? await db
        .select({ orgId: organizations.id })
        .from(organizations)
        .where(and(
          inArray(organizations.partnerId, partnerIds),
          ne(organizations.type, 'quick_support')
        ))
    : [];

  const orgIds = new Set<string>();
  for (const { orgId } of orgRows) {
    if (orgId) orgIds.add(orgId);
  }
  for (const { orgId } of partnerOrgRows) {
    orgIds.add(orgId);
  }

  if (orgIds.size === 0) return { enqueued: 0 };

  let enqueued = 0;

  // 2. For each org, resolve all backup-assigned devices via config policy hierarchy.
  for (const orgId of orgIds) {
    try {
      const entries = await resolveAllBackupAssignedDevices(orgId);

      for (const entry of entries) {
        // Broken profile link (deleted/RLS-hidden/empty/malformed selections):
        // skip loudly. Falling through would dispatch the legacy settings row,
        // which on a profile link carries no paths — a backup that protects
        // nothing while reporting success.
        //
        // The resolver flags this in selectionError, but re-derive it here too:
        // this is the last checkpoint before a backup runs, so it must not
        // depend on an upstream flag being set. A link that names a profile and
        // has no specs NEVER falls back to legacy dispatch.
        const profileId = entry.settings?.backupProfileId ?? null;
        const brokenProfileLink =
          entry.selectionError ??
          (profileId && !entry.selectionSpecs
            ? `Backup profile ${profileId} could not be resolved into any data source`
            : null);
        if (brokenProfileLink) {
          console.error(
            `[BackupWorker] Device ${entry.deviceId} (org ${orgId}, link ${entry.featureLinkId}): ${brokenProfileLink} — no backup scheduled`
          );
          continue;
        }

        // Destination chain already resolved (explicit → legacy → org
        // default). Nothing resolved = loud skip, never silent: a partner
        // policy hit an org with no default destination.
        if (!entry.configId) {
          console.error(
            `[BackupWorker] Device ${entry.deviceId} (org ${orgId}, link ${entry.featureLinkId}) has no backup destination — set an org default destination or pin one on the policy`
          );
          continue;
        }

        const schedule = entry.settings?.schedule as PolicySchedule | null;
        if (!schedule?.frequency || !schedule.time) continue;
        const occurrenceKey = getDueOccurrenceKey(
          schedule as never,
          now,
          entry.resolvedTimezone,
          SCHEDULE_LOOKBACK_MINUTES,
        );
        if (!occurrenceKey) continue;

        // Profile fan-out: one job per enabled selection. Legacy custom links
        // (no profile) create a single job with NULL mode, exactly as before.
        const specs = entry.selectionSpecs ?? [undefined];
        for (const spec of specs) {
          const result = await createScheduledBackupJobIfAbsent({
            orgId,
            configId: entry.configId,
            featureLinkId: entry.featureLinkId,
            deviceId: entry.deviceId,
            occurrenceKey,
            createdAt: now,
            dedupeWindowMinutes: SCHEDULE_LOOKBACK_MINUTES,
            ...(spec
              ? { backupMode: spec.backupMode, modeTargets: spec.targets }
              : {}),
          });

          if (result?.created) {
            // 6. Enqueue dispatch
            await enqueueBackupDispatch(
              result.job.id,
              result.job.configId,
              orgId,
              entry.deviceId
            );
            enqueued++;
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BackupWorker] Failed to process scheduled backups for org ${orgId}: ${errMsg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      continue;
    }
  }

  if (enqueued > 0) {
    console.log(
      `[BackupWorker] Scheduled ${enqueued} backup job(s) from config policies`
    );
  }

  return { enqueued };
}

async function processExpireRecoveryTokens(): Promise<{ expired: number }> {
  const now = new Date();
  const expired = await db
    .update(recoveryTokens)
    .set({ status: 'expired' })
    .where(
      and(
        eq(recoveryTokens.status, 'active'),
        isNull(recoveryTokens.authenticatedAt),
        lt(recoveryTokens.expiresAt, now)
      )
    )
    .returning({ id: recoveryTokens.id });

  return { expired: expired.length };
}

export async function processCleanupExpiredSnapshots(): Promise<{
  deleted: number;
  skipped: number;
  prunedByMaxVersions: number;
  gcDeleted: number;
  // GC's unit of work is a storage identity (possibly several backupConfigs
  // rows sharing one bucket), not a single "destination" row.
  gcSkippedIdentities: number;
  // Subset of gcSkippedIdentities that fail-closed on an unfetchable FILE-type
  // manifest — the distinct signal of a possible non-self-healing storage leak.
  gcBlockedIdentities: number;
}> {
  const orgRows = await db
    .selectDistinct({ orgId: backupSnapshots.orgId })
    .from(backupSnapshots);

  let deleted = 0;
  let skipped = 0;
  let prunedByMaxVersions = 0;

  for (const { orgId } of orgRows) {
    const result = await cleanupExpiredSnapshots(orgId);
    deleted += result.deleted;
    skipped += result.skippedLegalHold + result.skippedImmutable;
    prunedByMaxVersions += result.prunedByMaxVersions;
  }

  // Mark-and-sweep GC runs ONCE per retention cycle, after row-level
  // retention has finished for every org — not per-org, since a
  // destination's live set spans every retained snapshot regardless of
  // which org iteration deleted rows (see backupRetention.ts's
  // deleteSnapshotRow: row deletion no longer touches object storage at
  // all; GC is the only thing that does). A GC failure must never fail this
  // job: row-level retention already succeeded, and BullMQ would otherwise
  // retry/re-log the whole run over an unrelated object-storage problem.
  let gcDeleted = 0;
  let gcSkippedIdentities = 0;
  let gcBlockedIdentities = 0;
  try {
    const gcResult = await sweepUnreferencedBackupObjects();
    gcDeleted = gcResult.deleted;
    gcSkippedIdentities = gcResult.skippedIdentities;
    gcBlockedIdentities = gcResult.blockedIdentities;
  } catch (err) {
    console.error('[BackupWorker] Backup object GC sweep failed — retention run still succeeded:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  return { deleted, skipped, prunedByMaxVersions, gcDeleted, gcSkippedIdentities, gcBlockedIdentities };
}

// ── Backup target resolution ─────────────────────────────────────────────────

export interface BackupTarget {
  commandType: string;
  payload: Record<string, unknown>;
}

/**
 * Resolves backup mode + targets into one or more typed commands.
 *
 * For file/system_image, returns a single backup_run command.
 * For hyperv, queries discovered VMs and returns one hyperv_backup per VM (minus excludes).
 * For mssql, queries discovered SQL instances and returns one mssql_backup per database (minus excludes).
 */
export async function resolveBackupTargets(
  backupMode: string,
  targets: Record<string, unknown>,
  deviceId: string
): Promise<BackupTarget[]> {
  switch (backupMode) {
    case 'file': {
      const t = targets as { paths?: string[]; excludes?: string[] };
      // Preserve the omitted-vs-empty distinction the agent relies on: a
      // missing excludes field means "fall back to locally-configured
      // excludes", an explicit [] means "no exclusions for this run".
      const payload: Record<string, unknown> = { paths: t.paths ?? [] };
      if (t.excludes !== undefined) {
        payload.excludes = t.excludes;
      }
      return [{ commandType: 'backup_run', payload }];
    }

    case 'system_image':
      return [{ commandType: 'backup_run', payload: { systemImage: true } }];

    case 'hyperv': {
      const t = targets as {
        consistencyType?: string;
        excludeVms?: string[];
      };
      const vms = await db
        .select({ vmName: hypervVms.vmName })
        .from(hypervVms)
        .where(eq(hypervVms.deviceId, deviceId));

      const excludeSet = new Set(t.excludeVms ?? []);
      return vms
        .filter((vm) => !excludeSet.has(vm.vmName))
        .map((vm) => ({
          commandType: 'hyperv_backup',
          payload: {
            vmName: vm.vmName,
            consistencyType: t.consistencyType ?? 'application',
          },
        }));
    }

    case 'mssql': {
      const t = targets as {
        backupType?: string;
        excludeDatabases?: string[];
      };
      const instances = await db
        .select({
          instanceName: sqlInstances.instanceName,
          databases: sqlInstances.databases,
        })
        .from(sqlInstances)
        .where(eq(sqlInstances.deviceId, deviceId));

      const excludeSet = new Set(t.excludeDatabases ?? []);
      const results: BackupTarget[] = [];
      for (const inst of instances) {
        const dbs = Array.isArray(inst.databases) ? inst.databases : [];
        for (const databaseEntry of dbs) {
          const database =
            typeof databaseEntry === 'string'
              ? databaseEntry
              : databaseEntry &&
                  typeof databaseEntry === 'object' &&
                  'name' in databaseEntry &&
                  typeof databaseEntry.name === 'string'
                ? databaseEntry.name
                : null;
          if (!database) {
            continue;
          }
          if (!excludeSet.has(database)) {
            results.push({
              commandType: 'mssql_backup',
              payload: {
                instance: inst.instanceName,
                database,
                backupType: t.backupType ?? 'full',
              },
            });
          }
        }
      }
      return results;
    }

    default:
      console.error(`[BackupWorker] Unknown backup mode "${backupMode}" for device ${deviceId}`);
      return [];
  }
}

// ── dispatch-backup ───────────────────────────────────────────────────────────
//
// #1105 phase split (final-review fix, wave 3.5b #4084): processDispatchBackup
// used to run entirely inside the worker's blanket `runWithSystemDbAccess`
// wrap, so `isAgentConnectedAnywhere`, `recordDispatchedExpectation` and
// `dispatchCommandToAgent` — all Redis/WS I/O via the agentCommandRelay
// facade, the last with an ack-wait poll loop up to
// RELAY_DELIVERY_DEADLINE_MS — ran with a pooled Postgres connection pinned
// idle-in-transaction, multiplied by target count in the per-target loop.
//
// Fixed by splitting into short-lived contexts around just the DB work, with
// every facade call at depth 0:
//   Phase 1 (context)  loadBackupDispatchPrecheck    — cancellation, config, agent lookup
//   Phase 2 (no ctx)   isAgentConnectedAnywhere        — connectivity (facade)
//   Phase 3 (context)  prepareBackupDispatchTargets   — mode/targets, per-target
//                                                        command build + child job
//                                                        rows + recordDispatchedExpectation
//   Phase 4 (no ctx)   dispatchCommandToAgent per target — the actual sends (facade)
//   Phase 5 (context)  settle child-job failures + final job status
//
// recordDispatchedExpectation is a single Redis SET, not the unbounded ack
// poll — it stays in Phase 3's context deliberately (that's the at-most-once
// bookkeeping for a send that is about to happen, not the hazard this split
// exists to remove).
//
// Behavior note: cancellation is now checked at the start of each phase and at
// each Phase-3 loop iteration (as before), but NOT re-checked between
// individual Phase-4 sends — those all run after Phase 3's context has
// closed, so there is no DB read to interleave without reopening a context per
// target. A cancellation that lands mid-Phase-4 no longer aborts the
// remaining sends early; it still fails the job via the usual result handling
// once Phase 5 re-checks it.

type BackupDispatchPrecheck =
  | { status: 'done'; result: { dispatched: boolean } }
  | { status: 'ok'; config: typeof backupConfigs.$inferSelect; agentId: string };

/**
 * Phase 1: cancellation guard, config load and the agent lookup, inside ONE
 * short system DB context. Deliberately stops short of the connectivity
 * check — `isAgentConnectedAnywhere` is Redis I/O via the agentCommandRelay
 * facade and must run with no context held (#1105).
 */
async function loadBackupDispatchPrecheck(
  data: DispatchBackupJobData
): Promise<BackupDispatchPrecheck> {
  if (await isBackupJobCancelled(data.jobId)) {
    return { status: 'done', result: { dispatched: false } };
  }

  // Load config for command payload
  const [config] = await db
    .select()
    .from(backupConfigs)
    .where(eq(backupConfigs.id, data.configId))
    .limit(1);

  if (!config) {
    await markJobFailed(data.jobId, 'Backup config not found');
    return { status: 'done', result: { dispatched: false } };
  }

  if (await isBackupJobCancelled(data.jobId)) {
    return { status: 'done', result: { dispatched: false } };
  }

  // Find the agent for this device
  const [device] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  const agentId = device?.agentId;
  if (!agentId) {
    await markJobFailed(data.jobId, 'Agent not connected');
    return { status: 'done', result: { dispatched: false } };
  }

  return { status: 'ok', config, agentId };
}

interface PreparedBackupTarget {
  commandJobId: string;
  command: AgentCommand;
  commandType: string;
}

type BackupDispatchPrepare =
  | { status: 'done'; result: { dispatched: boolean } }
  | {
      status: 'ok';
      prepared: PreparedBackupTarget[];
      preFailedTargets: string[];
      backupMode: string;
      targetCount: number;
    };

/**
 * Phase 3: resolve the backup mode/targets, build every target's command
 * payload and record its dispatch expectation — all inside ONE short system
 * DB context (#1105). Nothing here calls `dispatchCommandToAgent`; that send
 * happens in Phase 4, after this context has closed.
 */
async function prepareBackupDispatchTargets(
  data: DispatchBackupJobData,
  config: typeof backupConfigs.$inferSelect,
): Promise<BackupDispatchPrepare> {
  if (await isBackupJobCancelled(data.jobId)) {
    return { status: 'done', result: { dispatched: false } };
  }

  // Resolve backup mode: fan-out jobs carry their own selection (profile
  // model); legacy jobs fall back to the feature link's settings row.
  const [job] = await db
    .select({
      featureLinkId: backupJobs.featureLinkId,
      backupMode: backupJobs.backupMode,
      modeTargets: backupJobs.modeTargets,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, data.jobId))
    .limit(1);

  let backupMode = 'file';
  let modeTargets: Record<string, unknown> = {};

  if (job?.backupMode) {
    backupMode = job.backupMode;
    modeTargets = (job.modeTargets as Record<string, unknown>) ?? {};
  } else if (job?.featureLinkId) {
    const [settings] = await db
      .select({
        backupMode: configPolicyBackupSettings.backupMode,
        targets: configPolicyBackupSettings.targets,
      })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    if (settings) {
      backupMode = settings.backupMode;
      modeTargets = (settings.targets as Record<string, unknown>) ?? {};
    }
  }

  // Resolve targets into typed commands based on backup mode
  const targets = await resolveBackupTargets(backupMode, modeTargets, data.deviceId);

  if (await isBackupJobCancelled(data.jobId)) {
    return { status: 'done', result: { dispatched: false } };
  }

  if (targets.length === 0) {
    console.warn(`[BackupWorker] No backup targets resolved for job ${data.jobId} (mode=${backupMode}, device=${data.deviceId}) — marking job failed`);
    await db
      .update(backupJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
        errorLog: `No backup targets resolved (mode=${backupMode}). Ensure discovery has been run for this device.`,
      })
      .where(eq(backupJobs.id, data.jobId));
    return { status: 'done', result: { dispatched: false } };
  }

  const providerConfig = config.providerConfig as Record<string, unknown>;
  const encryptionPlan = resolveBackupStorageEncryptionPlan({
    encryption: config.encryption,
    provider: config.provider,
    providerConfig,
  });
  if (encryptionPlan.required && encryptionPlan.status === 'unsupported') {
    await markJobFailed(data.jobId, encryptionPlan.reason);
    return { status: 'done', result: { dispatched: false } };
  }

  const commandProviderConfig =
    encryptionPlan.required && encryptionPlan.status === 'enforced'
      ? { ...providerConfig, ...encryptionPlan.providerConfigPatch }
      : providerConfig;

  const prepared: PreparedBackupTarget[] = [];
  const preFailedTargets: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    if (await isBackupJobCancelled(data.jobId)) {
      return { status: 'done', result: { dispatched: false } };
    }

    const target = targets[i]!;

    // First target reuses the original jobId; additional targets get their own DB row
    let commandJobId = data.jobId;
    if (i > 0) {
      const [newJob] = await db
        .insert(backupJobs)
        .values({
          orgId: data.orgId,
          configId: data.configId,
          featureLinkId: job?.featureLinkId ?? null,
          deviceId: data.deviceId,
          status: 'running',
          type: 'scheduled',
          startedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      if (!newJob?.id) {
        console.error(`[BackupWorker] Failed to create child job for target ${i} (${target.commandType}), skipping`);
        preFailedTargets.push(`${target.commandType} (job creation failed)`);
        continue;
      }
      commandJobId = newJob.id;

      if (await isBackupJobCancelled(data.jobId)) {
        await markBackupJobCancelled(commandJobId, 'Cancelled before dispatch');
        return { status: 'done', result: { dispatched: false } };
      }
    }

    const command: AgentCommand = {
      id: commandJobId,
      type: target.commandType,
      payload: {
        jobId: commandJobId,
        configId: data.configId,
        provider: config.provider,
        providerConfig: commandProviderConfig,
        storageEncryption: encryptionPlan.required
          ? {
              required: true,
              mode: encryptionPlan.mode,
              keyReference: encryptionPlan.keyReference,
            }
          : {
              required: false,
              mode: 'disabled',
            },
        ...target.payload,
      },
    };

    // Record the server-side dispatch expectation BEFORE sending so the WS
    // result handler can verify this completion corresponds to work we actually
    // dispatched and hasn't already been consumed (F6). Recording first closes
    // the (otherwise negligible) window where a result could arrive before the
    // expectation lands. If the send then fails, the orphaned expectation is
    // harmless — it expires via TTL and can't be consumed without a matching
    // job + owning device. Best-effort: a Redis outage makes the result
    // fail-closed on arrival (dropped), not trusted.
    await recordDispatchedExpectation('backup', data.deviceId, commandJobId);

    prepared.push({ commandJobId, command, commandType: target.commandType });
  }

  return { status: 'ok', prepared, preFailedTargets, backupMode, targetCount: targets.length };
}

async function processDispatchBackup(
  data: DispatchBackupJobData
): Promise<{ dispatched: boolean }> {
  // Phase 1 — cancellation guard, config load, agent lookup: ONE short system
  // DB context, then it CLOSES.
  const precheck = await runWithSystemDbAccess(() => loadBackupDispatchPrecheck(data));
  if (precheck.status === 'done') return precheck.result;
  const { config, agentId } = precheck;

  // Phase 2 — connectivity check with NO DB context open (#1105).
  if (!(await isAgentConnectedAnywhere(agentId))) {
    await runWithSystemDbAccess(() => markJobFailed(data.jobId, 'Agent not connected'));
    return { dispatched: false };
  }

  // Phase 3 — resolve targets, build every command payload and record its
  // dispatch expectation: another short system DB context, then it CLOSES
  // before any target is actually sent.
  const prepare = await runWithSystemDbAccess(() => prepareBackupDispatchTargets(data, config));
  if (prepare.status === 'done') return prepare.result;
  const { prepared, preFailedTargets, backupMode, targetCount } = prepare;

  // Phase 4 — the actual WS/relay sends, NO DB context open. Each
  // dispatchCommandToAgent call may poll for a relay ack for up to
  // RELAY_DELIVERY_DEADLINE_MS; holding a transaction across `targetCount` of
  // these is exactly the #1105 hold this split removes.
  let sentCount = 0;
  const failedTargets: string[] = [...preFailedTargets];
  let lastNonOfflineOutcomeStatus: string | null = null;
  const failedChildJobs: Array<{ commandJobId: string; detail: string }> = [];

  for (const target of prepared) {
    const outcome = await dispatchCommandToAgent(agentId, target.command);
    if (outcome.status === 'sent') {
      sentCount++;
      continue;
    }

    const detail = outcome.status === 'offline'
      ? `Failed to send ${target.commandType} command to agent`
      : `Failed to send ${target.commandType} command to agent (dispatch outcome ${outcome.status})`;
    console.warn(`[BackupWorker] ${detail} for job ${target.commandJobId}`);
    failedTargets.push(target.commandType);
    if (outcome.status !== 'offline') {
      lastNonOfflineOutcomeStatus = outcome.status;
    }
    if (target.commandJobId !== data.jobId) {
      failedChildJobs.push({ commandJobId: target.commandJobId, detail });
    }
  }

  // Phase 5 — settle per-target failure rows and the final job status: one
  // more short system DB context.
  return runWithSystemDbAccess(async () => {
    // Failed-send child rows settle UNCONDITIONALLY, before the cancel check —
    // a cancel racing the sends must not strand them at status 'running' (the
    // cancel route only touches the parent id, nothing else sweeps children).
    for (const failure of failedChildJobs) {
      await db
        .update(backupJobs)
        .set({ status: 'failed', completedAt: new Date(), updatedAt: new Date(), errorLog: failure.detail })
        .where(eq(backupJobs.id, failure.commandJobId));
    }

    if (await isBackupJobCancelled(data.jobId)) {
      return { dispatched: false };
    }

    if (sentCount === 0) {
      await markJobFailed(
        data.jobId,
        lastNonOfflineOutcomeStatus
          ? `Failed to send command to agent (dispatch outcome ${lastNonOfflineOutcomeStatus})`
          : 'Failed to send command to agent',
      );
      return { dispatched: false };
    }

    if (failedTargets.length > 0) {
      console.warn(
        `[BackupWorker] Partial dispatch for job ${data.jobId}: ${sentCount}/${targetCount} sent, failed targets: ${failedTargets.join(', ')}`
      );
      await db
        .update(backupJobs)
        .set({ errorLog: `Partial dispatch: ${failedTargets.length} target(s) failed to send (${failedTargets.join(', ')})`, updatedAt: new Date() })
        .where(eq(backupJobs.id, data.jobId));
    }

    await db
      .update(backupJobs)
      .set({
        status: 'running',
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(backupJobs.id, data.jobId),
        inArray(backupJobs.status, ['pending', 'running'])
      ));

    console.log(
      `[BackupWorker] Dispatched ${sentCount}/${targetCount} ${backupMode} command(s) to agent ${agentId} for job ${data.jobId}`
    );
    return { dispatched: true };
  });
}

// ── process-results ───────────────────────────────────────────────────────────

async function processResults(
  data: ProcessResultsJobData
): Promise<{ processed: boolean }> {
  const resultStatus = data.result.status;
  const parsed = backupCommandResultSchema.safeParse(data.result);
  if (!parsed.success) {
    await markBackupJobFailedIfInFlight(
      data.jobId,
      `Malformed backup result payload: ${describeZodIssues(parsed.error)}`,
    );
    return { processed: false };
  }

  const result = parsed.data;
  await applyBackupCommandResultToJob({
    jobId: data.jobId,
    orgId: data.orgId,
    deviceId: data.deviceId,
    resultStatus,
    // NB: NOT `result.status` — backupCommandResultSchema parsed `data.result`,
    // whose `status` is the OUTER command status. The agent's own terminal
    // status rides the distinct `agentStatus` key (see backupProcessResultSchema).
    agentStatus: data.result.agentStatus,
    result: {
      ...result,
      error: data.result.error,
    },
  });

  console.log(
    // Include the agent's own status: `resultStatus` is only ever
    // completed/failed, so without this a `partial` run is invisible in the
    // API logs even though the DB row records it (#3000).
    `[BackupWorker] Job ${data.jobId} result processed: ${resultStatus}` +
    (data.result.agentStatus ? ` (agent: ${data.result.agentStatus})` : '')
  );
  return { processed: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function markJobFailed(jobId: string, error: string): Promise<void> {
  await db
    .update(backupJobs)
    .set({ status: 'failed', completedAt: new Date(), errorLog: error, updatedAt: new Date() })
    .where(and(
      eq(backupJobs.id, jobId),
      inArray(backupJobs.status, ['pending', 'running'])
    ));
}

async function markBackupJobCancelled(jobId: string, error: string): Promise<void> {
  await db
    .update(backupJobs)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      updatedAt: new Date(),
      errorLog: error,
    })
    .where(and(
      eq(backupJobs.id, jobId),
      inArray(backupJobs.status, ['pending', 'running'])
    ));
}

async function isBackupJobCancelled(jobId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: backupJobs.status })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  return row?.status === 'cancelled';
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let backupWorkerInstance: Worker<BackupQueueJobData> | null = null;

export async function initializeBackupWorker(): Promise<void> {
  try {
    backupWorkerInstance = createBackupWorker();
    attachWorkerObservability(backupWorkerInstance, 'backupWorker');

    backupWorkerInstance.on('error', (error) => {
      console.error('[BackupWorker] Worker error:', error);
    });

    backupWorkerInstance.on('failed', (job, error) => {
      console.error(`[BackupWorker] Job ${job?.id} failed:`, error);
    });

    // Schedule recurring check-schedules job (every 60s)
    const queue = getBackupQueue();
    const newJob = await queue.add(
      'check-schedules',
      backupQueueJobDataSchema.parse(
        withQueueMeta({ type: 'check-schedules' as const }, BACKUP_REPEATABLE_META)
      ),
      {
        repeat: { every: 60_000 },
        attempts: 1,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    const expireJob = await queue.add(
      'expire-recovery-tokens',
      backupQueueJobDataSchema.parse(
        withQueueMeta({ type: 'expire-recovery-tokens' as const }, BACKUP_REPEATABLE_META)
      ),
      {
        // Hourly at a registry-allocated minute (jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('backup-recovery-token-expiry') },
        attempts: 1,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    const cleanupJob = await queue.add(
      'cleanup-expired-snapshots',
      backupQueueJobDataSchema.parse(
        withQueueMeta({ type: 'cleanup-expired-snapshots' as const }, BACKUP_REPEATABLE_META)
      ),
      {
        // Every 6h at a registry-allocated slot (jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('backup-expired-snapshot-cleanup') },
        attempts: 1,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    // Clean up stale repeatable jobs
    const repeatable = await queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (
        (job.name === 'check-schedules' && job.key !== newJob.repeatJobKey) ||
        (job.name === 'expire-recovery-tokens' && job.key !== expireJob.repeatJobKey) ||
        (job.name === 'cleanup-expired-snapshots' && job.key !== cleanupJob.repeatJobKey)
      ) {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    console.log('[BackupWorker] Backup worker initialized');
  } catch (error) {
    console.error('[BackupWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownBackupWorker(): Promise<void> {
  if (backupWorkerInstance) {
    await backupWorkerInstance.close();
    backupWorkerInstance = null;
  }

  await backupEnqueue.closeBackupQueue();

  console.log('[BackupWorker] Backup worker shut down');
}

// Exported for unit tests of the schedule fan-out (profile expansion + loud
// skips). Internal helper, not part of the worker's public surface.
export const __testOnly = {
  processCheckSchedules,
  // Exposed so the agentStatus hop can be tested: this function is the only
  // thing carrying a `partial` run from the queue payload into persistence, and
  // dropping that one argument silently reverts #3000 with nothing going red.
  processResults,
  // Exposed for the wave 3.5b (#4084) dispatch-facade migration tests.
  processDispatchBackup,
};
