import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  index,
  text
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { devices } from './devices';

export const deviceSessionTypeEnum = pgEnum('device_session_type', ['console', 'rdp', 'ssh', 'other']);
export const deviceSessionActivityStateEnum = pgEnum('device_session_activity_state', [
  'active',
  'idle',
  'locked',
  'away',
  'disconnected'
]);

export const deviceSessions = pgTable('device_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  username: varchar('username', { length: 255 }).notNull(),
  sessionType: deviceSessionTypeEnum('session_type').notNull().default('console'),
  osSessionId: varchar('os_session_id', { length: 128 }),
  loginAt: timestamp('login_at').notNull().defaultNow(),
  logoutAt: timestamp('logout_at'),
  durationSeconds: integer('duration_seconds'),
  idleMinutes: integer('idle_minutes'),
  activityState: deviceSessionActivityStateEnum('activity_state'),
  loginPerformanceSeconds: integer('login_performance_seconds'),
  isActive: boolean('is_active').notNull().default(true),
  lastActivityAt: timestamp('last_activity_at'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  orgActiveIdx: index('device_sessions_org_active_idx').on(table.orgId, table.isActive),
  deviceActiveIdx: index('device_sessions_device_active_idx').on(table.deviceId, table.isActive),
  deviceLoginIdx: index('device_sessions_device_login_idx').on(table.deviceId, table.loginAt),
  deviceUserIdx: index('device_sessions_device_user_idx').on(table.deviceId, table.username),
  // #4342 W1 retention (2027-01-23-093000, built CONCURRENTLY): closed-session age scan.
  closedAgeIdx: index('device_sessions_closed_age_idx')
    .on(sql`(COALESCE(${table.logoutAt}, ${table.updatedAt}))`)
    .where(sql`${table.isActive} = false`),
}));
