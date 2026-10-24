import {
  index, jsonb, pgTable, text, timestamp, uuid, varchar, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  MemoryBlockStatus, MemoryBlockTypeName, MemoryConfidence, MemoryOwnerKind,
} from '@breeze/shared';
import { aiSessions } from './ai';
import { partners } from './orgs';

/**
 * Wisp memory blocks (W03, feature #9906). Partner-axis anchor
 * (`tenant_partner_id`) with owner sub-axes: user, org or partner, selected by
 * `owner_kind`. RLS branches on `owner_kind` — see
 * migrations/2027-01-04-110100-ai-memory-blocks.sql.
 *
 * The five CHECKs (owner kind, owner shape, block type, confidence, status) and
 * the two DEFERRABLE composite FKs — (owner_user_id, tenant_partner_id) → users
 * and (owner_org_id, tenant_partner_id) → organizations, both ON DELETE CASCADE —
 * live in the migration only (the fixOutcomes convention). The authored_by_grant_*
 * columns are provenance pointers with no FK.
 */
export const aiMemoryBlocks = pgTable('ai_memory_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantPartnerId: uuid('tenant_partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  ownerKind: text('owner_kind').$type<MemoryOwnerKind>().notNull(),
  ownerUserId: uuid('owner_user_id'),
  ownerOrgId: uuid('owner_org_id'),
  blockType: text('block_type').$type<MemoryBlockTypeName>().notNull(),
  subjectKey: varchar('subject_key', { length: 280 }).notNull(),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  confidence: text('confidence').$type<MemoryConfidence>().notNull().default('medium'),
  status: text('status').$type<MemoryBlockStatus>().notNull().default('unconfirmed'),
  authoredByGrantId: uuid('authored_by_grant_id'),
  authoredByGrantRevisionId: uuid('authored_by_grant_revision_id'),
  supersededById: uuid('superseded_by_id')
    .references((): AnyPgColumn => aiMemoryBlocks.id, { onDelete: 'set null' }),
  sourceSessionId: uuid('source_session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantOwnerSubjectIdx: index('ai_memory_blocks_tenant_owner_subject_idx').on(t.tenantPartnerId, t.ownerKind, t.subjectKey),
}));

export type AiMemoryBlockRow = typeof aiMemoryBlocks.$inferSelect;
