// NOTE: the SQL files in migrations/ are the DDL source of truth — they carry
// FKs to core-platform tables (organizations, devices, users, ai_sessions),
// the RLS policies, and the trigram indexes, none of which appear here. Do not
// generate migrations from these definitions with drizzle-kit.
import {
  pgTable, uuid, text, varchar, boolean, bigint, integer, timestamp, jsonb, pgEnum,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';

export const workspaceSourceKind = pgEnum('workspace_source_kind', ['smb_share', 'local_profile']);
export const workspaceSourceStatus = pgEnum('workspace_source_status', ['active', 'paused', 'error']);
export const workspaceFileAction = pgEnum('workspace_file_action', ['open', 'reveal', 'copy_path']);
export const workspaceCrawlStatus = pgEnum('workspace_crawl_status', [
  'running', 'complete', 'failed', 'abandoned',
]);

export const workspaceSources = pgTable('workspace_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  kind: workspaceSourceKind('kind').notNull(),
  displayName: text('display_name').notNull(),
  rootPath: text('root_path').notNull(),
  crawlDeviceId: uuid('crawl_device_id'),
  visibilityGroupIds: jsonb('visibility_group_ids').$type<string[]>().notNull().default([]),
  credentialEnc: text('credential_enc'),
  excludeGlobs: jsonb('exclude_globs').$type<string[]>().notNull().default([]),
  watch: boolean('watch').notNull().default(false),
  crawlCadenceMinutes: integer('crawl_cadence_minutes').notNull().default(360),
  // Reserved (no writer yet): crawlCursor — run cursors live on
  // workspace_crawl_runs.cursor; statusDetail — errorReason is used instead.
  crawlCursor: jsonb('crawl_cursor').notNull().default({}),
  status: workspaceSourceStatus('status').notNull().default('active'),
  statusDetail: text('status_detail'),
  errorReason: text('error_reason'),
  lastCompleteRunAt: timestamp('last_complete_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('wsp_sources_org_idx').on(t.orgId)]);

export const workspaceFileIndex = pgTable('workspace_file_index', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  sourceId: uuid('source_id').notNull().references(() => workspaceSources.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id'),
  // NULL-proof stand-in for device_id in the unique index below (unique
  // indexes treat NULLs as distinct); zero-uuid = source-scoped/SMB rows.
  // Invariant device_key = COALESCE(device_id, zero-uuid) is app-enforced
  // only — every writer must go through services/runScope.ts.
  deviceKey: uuid('device_key').notNull().default('00000000-0000-0000-0000-000000000000'),
  relPath: text('rel_path').notNull(),
  parentPath: text('parent_path').notNull().default(''),
  name: text('name').notNull(),
  isDir: boolean('is_dir').notNull().default(false),
  ext: text('ext'),
  mime: text('mime'),
  size: bigint('size', { mode: 'number' }),
  mtime: timestamp('mtime', { withTimezone: true }),
  ctime: timestamp('ctime', { withTimezone: true }),
  attrs: jsonb('attrs').notNull().default({}),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wsp_file_index_org_source_device_rel_path_unique')
    .on(t.orgId, t.sourceId, t.deviceKey, t.relPath),
  index('wsp_file_index_parent_idx').on(t.orgId, t.sourceId, t.parentPath),
]);

export const workspaceCrawlRuns = pgTable('workspace_crawl_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  sourceId: uuid('source_id').notNull().references(() => workspaceSources.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id'),
  // Same COALESCE(device_id, zero-uuid) convention as workspace_file_index —
  // see services/runScope.ts.
  deviceKey: uuid('device_key').notNull().default('00000000-0000-0000-0000-000000000000'),
  status: workspaceCrawlStatus('status').notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cursor: text('cursor'),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
  errorReason: text('error_reason'),
}, (t) => [index('wsp_crawl_runs_org_source_status_idx').on(t.orgId, t.sourceId, t.status)]);

export const workspaceFileActivity = pgTable('workspace_file_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  userId: uuid('user_id'),
  fileIndexId: uuid('file_index_id').notNull().references(() => workspaceFileIndex.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id'),
  // Device-local free-text display label for helper sessions (never authorization).
  helperUser: varchar('helper_user', { length: 100 }),
  action: workspaceFileAction('action').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('wsp_file_activity_org_user_idx').on(t.orgId, t.userId, t.createdAt.desc())]);
