import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  boolean,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';

export const hypervVms = pgTable(
  'hyperv_vms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    vmId: varchar('vm_id', { length: 64 }).notNull(),
    vmName: varchar('vm_name', { length: 256 }).notNull(),
    generation: integer('generation').notNull().default(1),
    state: varchar('state', { length: 30 }).notNull().default('unknown'),
    vhdPaths: jsonb('vhd_paths').default([]),
    memoryMb: bigint('memory_mb', { mode: 'number' }),
    processorCount: integer('processor_count'),
    rctEnabled: boolean('rct_enabled').default(false),
    hasPassthroughDisks: boolean('has_passthrough_disks').default(false),
    checkpoints: jsonb('checkpoints').default([]),
    notes: text('notes'),
    lastDiscoveredAt: timestamp('last_discovered_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgDeviceIdx: index('hyperv_vms_org_device_idx').on(
      table.orgId,
      table.deviceId
    ),
    deviceVmUnique: unique('hyperv_vms_device_vm_unique').on(
      table.deviceId,
      table.vmId
    ),
  })
);
