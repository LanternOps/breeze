import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, pgEnum, integer, bigint, boolean, index } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { users } from './users';
import { organizations } from './orgs';

export const tunnelTypeEnum = pgEnum('tunnel_type', ['vnc', 'proxy']);
export const tunnelStatusEnum = pgEnum('tunnel_status', ['pending', 'connecting', 'active', 'disconnected', 'failed']);
// A VNC tunnel that is still live (or coming up). Inline literals on purpose,
// so the planner can use tunnel_sessions_device_live_vnc_idx under generic
// plans; must match that index's predicate as created by its migration
// (2026-11-29-110000-device-live-session-indexes.sql). Parenthesised so
// it stays one term inside not()/or().
export const tunnelSessionIsLiveVnc = (type: AnyColumn | SQL, status: AnyColumn | SQL) =>
  sql`(${type} = 'vnc' AND ${status} IN ('pending', 'connecting', 'active'))`;

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
  // http/https for proxy sessions; null for VNC and pre-existing rows (callers
  // fall back to port inference when null).
  scheme: varchar('scheme', { length: 5 }),
  // When true, the agent skips TLS cert verification for this session's HTTPS
  // target (explicit opt-in for known self-signed embedded LAN devices).
  skipTlsVerify: boolean('skip_tls_verify').notNull().default(false),
  sourceIp: varchar('source_ip', { length: 45 }),
  bytesSent: bigint('bytes_sent', { mode: 'number' }).default(0),
  bytesRecv: bigint('bytes_recv', { mode: 'number' }).default(0),
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  durationSeconds: integer('duration_seconds'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Bumped by tunnelHttp on every authenticated proxied response (throttled
  // >30s). Nullable: pre-existing rows and never-exchanged pending rows have
  // no activity yet. Drives the server-computed idleSeconds the client polls
  // instead of comparing a server timestamp against the browser clock.
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
}, (t) => [
  // GET /remote/devices/:deviceId/active-sessions reads a device's live VNC rows.
  // Created CONCURRENTLY by 2026-11-29-110000-device-live-session-indexes.sql.
  index('tunnel_sessions_device_live_vnc_idx')
    .on(t.deviceId)
    .where(tunnelSessionIsLiveVnc(t.type, t.status)),
]);

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
