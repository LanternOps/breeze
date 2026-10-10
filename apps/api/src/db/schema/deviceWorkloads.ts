import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  WorkloadCollection,
  WorkloadDetection,
  WorkloadEnumeratedRuntime,
  WorkloadKind,
  WorkloadRuntime,
  WorkloadState,
} from '@breeze/shared';
import { devices } from './devices';
import { organizations } from './orgs';

// One row per workload (container / VM / LXC) on a workload host (#3834).
// Typed columns only — no jsonb/bytea (D1). Reconciled per runtime by
// services/workloads/ingest.ts. Migration 2026-12-20-230000-device-workloads.sql
// declares the composite FK DEFERRABLE INITIALLY IMMEDIATE (drizzle's
// foreignKey() builder has no deferrable option) and has NO partner-export
// triggers (D12).
export const deviceWorkloads = pgTable(
  'device_workloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    runtime: varchar('runtime', { length: 20 }).$type<WorkloadEnumeratedRuntime>().notNull(),
    kind: varchar('kind', { length: 20 }).$type<WorkloadKind>().notNull(),
    workloadId: varchar('workload_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    state: varchar('state', { length: 20 }).$type<WorkloadState>().notNull(),
    rawState: varchar('raw_state', { length: 40 }),
    imageRef: varchar('image_ref', { length: 512 }),
    imageRepository: varchar('image_repository', { length: 400 }),
    imageTag: varchar('image_tag', { length: 128 }),
    imageDigest: varchar('image_digest', { length: 80 }),
    imageId: varchar('image_id', { length: 80 }),
    guestOs: varchar('guest_os', { length: 128 }),
    composeProject: varchar('compose_project', { length: 128 }),
    composeService: varchar('compose_service', { length: 128 }),
    composeWorkingDir: varchar('compose_working_dir', { length: 512 }),
    restartPolicy: varchar('restart_policy', { length: 30 }),
    cpuCount: integer('cpu_count'),
    memoryMb: integer('memory_mb'),
    startedAt: timestamp('started_at'),
    runtimeCreatedAt: timestamp('runtime_created_at'),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_workloads_device_runtime_workload_uniq').on(t.deviceId, t.runtime, t.workloadId),
    index('device_workloads_org_id_idx').on(t.orgId),
    index('device_workloads_org_image_idx')
      .on(t.orgId, t.imageRepository, t.imageTag)
      .where(sql`${t.kind} = 'container'`),
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_workloads_device_org_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('device_workloads_runtime_chk', sql`${t.runtime} IN ('docker', 'podman', 'hyperv', 'proxmox')`),
    check('device_workloads_kind_chk', sql`${t.kind} IN ('container', 'vm', 'lxc')`),
    check(
      'device_workloads_state_chk',
      sql`${t.state} IN ('running', 'stopped', 'paused', 'restarting', 'other')`,
    ),
  ],
);

// One row per (device, runtime): detection (is it installed) kept apart from
// collection (did we enumerate it). An `absent` runtime keeps its row (detection
// = 'absent', workloads deleted) so the ordering guard still holds (§4.2).
export const deviceWorkloadRuntimes = pgTable(
  'device_workload_runtimes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    runtime: varchar('runtime', { length: 20 }).$type<WorkloadRuntime>().notNull(),
    detection: varchar('detection', { length: 20 }).$type<WorkloadDetection>().notNull(),
    collection: varchar('collection', { length: 24 }).$type<WorkloadCollection>().notNull(),
    complete: boolean('complete').notNull(),
    runtimeVersion: varchar('runtime_version', { length: 64 }),
    observedCount: integer('observed_count'),
    reportedCount: integer('reported_count'),
    lastError: varchar('last_error', { length: 500 }),
    // The agent's snapshot time: the ordering guard compares against this.
    collectedAt: timestamp('collected_at').notNull(),
    // Server receive time of the latest accepted report.
    lastAttemptAt: timestamp('last_attempt_at').notNull(),
    lastSuccessAt: timestamp('last_success_at'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_workload_runtimes_device_runtime_uniq').on(t.deviceId, t.runtime),
    index('device_workload_runtimes_org_id_idx').on(t.orgId),
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_workload_runtimes_device_org_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'device_workload_runtimes_runtime_chk',
      sql`${t.runtime} IN ('docker', 'podman', 'hyperv', 'proxmox', 'containerd')`,
    ),
    check('device_workload_runtimes_detection_chk', sql`${t.detection} IN ('present', 'absent', 'unknown')`),
    check(
      'device_workload_runtimes_collection_chk',
      sql`${t.collection} IN ('ok', 'disabled', 'unavailable', 'permission_denied', 'error', 'unsupported')`,
    ),
  ],
);
