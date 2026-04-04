import { pgTable, uuid, varchar, text, timestamp, pgEnum, integer, bigint, boolean } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { users } from './users';
import { organizations } from './orgs';

export const tunnelTypeEnum = pgEnum('tunnel_type', ['vnc', 'proxy']);
export const tunnelStatusEnum = pgEnum('tunnel_status', ['pending', 'connecting', 'active', 'disconnected', 'failed']);
export const tunnelAllowlistDirectionEnum = pgEnum('tunnel_allowlist_direction', ['destination', 'source']);

export const tunnelSessions = pgTable('tunnel_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: tunnelTypeEnum('type').notNull(),
  status: tunnelStatusEnum('status').notNull().default('pending'),
  targetHost: varchar('target_host', { length: 255 }).notNull(),
  targetPort: integer('target_port').notNull(),
  sourceIp: varchar('source_ip', { length: 45 }),
  bytesSent: bigint('bytes_sent', { mode: 'bigint' }).default(0n),
  bytesRecv: bigint('bytes_recv', { mode: 'bigint' }).default(0n),
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  durationSeconds: integer('duration_seconds'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const tunnelAllowlistSourceEnum = pgEnum('tunnel_allowlist_source', ['manual', 'discovery', 'policy']);

export const tunnelAllowlists = pgTable('tunnel_allowlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id'),
  direction: tunnelAllowlistDirectionEnum('direction').notNull(),
  pattern: varchar('pattern', { length: 255 }).notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  source: tunnelAllowlistSourceEnum('source').notNull().default('manual'),
  discoveredAssetId: uuid('discovered_asset_id'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
