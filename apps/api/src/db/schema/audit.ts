import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer, boolean, bigserial, bigint } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

export const actorTypeEnum = pgEnum('actor_type', ['user', 'api_key', 'agent', 'system']);
export const auditResultEnum = pgEnum('audit_result', ['success', 'failure', 'denied']);
export const initiatedByEnum = pgEnum('initiated_by_type', ['manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration']);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  actorType: actorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id').notNull(),
  actorEmail: varchar('actor_email', { length: 255 }),
  action: varchar('action', { length: 100 }).notNull(),
  resourceType: varchar('resource_type', { length: 50 }).notNull(),
  resourceId: uuid('resource_id'),
  resourceName: varchar('resource_name', { length: 255 }),
  details: jsonb('details'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  result: auditResultEnum('result').notNull(),
  errorMessage: text('error_message'),
  checksum: varchar('checksum', { length: 128 }),
  prevChecksum: varchar('prev_checksum', { length: 128 }),
  initiatedBy: initiatedByEnum('initiated_by'),
});

// Side table for the tamper-evidence chain (issue #1002). Written ONLY by the
// deferred commit-time seal trigger (see migration 2026-06-11-h, issue #1002) — application
// code never inserts here directly. chain_seq is the chain order; the legacy
// checksum/prev_checksum columns on audit_logs are vestigial (content-only /
// NULL for new rows).
export const auditLogChain = pgTable('audit_log_chain', {
  chainSeq: bigserial('chain_seq', { mode: 'number' }).primaryKey(),
  auditId: uuid('audit_id').notNull().references(() => auditLogs.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  contentChecksum: varchar('content_checksum', { length: 128 }).notNull(),
  prevChainChecksum: varchar('prev_chain_checksum', { length: 128 }),
  chainChecksum: varchar('chain_checksum', { length: 128 }).notNull(),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
});

// External-anchor snapshots for the audit chain (issue #916). Append-only:
// breeze_app may INSERT but never UPDATE/DELETE (enforced via grants + the
// audit_chain_anchor_immutable trigger in migration 2026-06-13-c). Each row
// snapshots the audit_log_chain head (seq + checksum) and entry count for one
// org at a point in time so a forged-chain-after-DELETE — which leaves
// audit_log_verify_chain internally consistent — is still detectable as a
// backwards move / shrink against the last anchor. signature/signingKeyId are
// the app-layer Ed25519 seam (NULL when AUDIT_ANCHOR_SIGNING is not configured).
export const auditChainAnchors = pgTable('audit_chain_anchors', {
  anchorSeq: bigserial('anchor_seq', { mode: 'number' }).primaryKey(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  headChainSeq: bigint('head_chain_seq', { mode: 'number' }).notNull(),
  headChainChecksum: varchar('head_chain_checksum', { length: 128 }),
  entryCount: bigint('entry_count', { mode: 'number' }).notNull(),
  signature: text('signature'),
  signingKeyId: varchar('signing_key_id', { length: 128 }),
  anchoredAt: timestamp('anchored_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditRetentionPolicies = pgTable('audit_retention_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  retentionDays: integer('retention_days').notNull().default(365),
  archiveToS3: boolean('archive_to_s3').notNull().default(false),
  lastCleanupAt: timestamp('last_cleanup_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
