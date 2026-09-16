import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Tool Catalog W01 (#5215 / #5216) — BYO MCP tool sources.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.
 *
 * A tool source is one registration of an external MCP server. Ownership
 * follows CLAUDE.md "Partner-Wide First": org_id XOR partner_id, enforced by
 * `tool_sources_one_owner_chk` / `tool_source_tools_one_owner_chk` in
 * 2026-10-16-193500-tool-sources.sql (CHECKs live in the migration, per the
 * house convention).
 *
 * `tool_source_tools` DENORMALISES the owner from its parent so the resolver
 * can read enabled tools with one indexed dual-axis query; a constraint
 * trigger (`tool_source_tools_owner_guard_trg`) keeps the two in step.
 *
 * `auth_config_encrypted` is registered in `services/encryptedColumnRegistry.ts`
 * with `aadBinding: 'row'`, so a ciphertext moved to another row (i.e. another
 * tenant) does not decrypt.
 */
export const toolSourceKindEnum = pgEnum('tool_source_kind', ['mcp', 'openapi']);
export const toolSourceAuthKindEnum = pgEnum('tool_source_auth_kind', [
  'none',
  'bearer',
  'api_key_header',
  'basic',
  'oauth2_client_credentials',
]);
export const toolSourceStatusEnum = pgEnum('tool_source_status', ['active', 'error', 'disabled']);

export const toolSources = pgTable(
  'tool_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 24 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    kind: toolSourceKindEnum('kind').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    /** Origin the credential is pinned to — `new URL(endpointUrl).origin`. */
    credentialOrigin: text('credential_origin').notNull(),
    authKind: toolSourceAuthKindEnum('auth_kind').notNull().default('none'),
    authConfigEncrypted: text('auth_config_encrypted'),
    authFingerprint: text('auth_fingerprint'),
    status: toolSourceStatusEnum('status').notNull().default('active'),
    lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }),
    lastError: text('last_error'),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(120),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgSlugUq: uniqueIndex('tool_sources_org_slug_uq')
      .on(table.orgId, table.slug)
      .where(sql`${table.orgId} IS NOT NULL`),
    partnerSlugUq: uniqueIndex('tool_sources_partner_slug_uq')
      .on(table.partnerId, table.slug)
      .where(sql`${table.partnerId} IS NOT NULL`),
    orgIdIdx: index('tool_sources_org_id_idx').on(table.orgId),
    partnerIdIdx: index('tool_sources_partner_id_idx').on(table.partnerId),
  }),
);

export const toolSourceTools = pgTable(
  'tool_source_tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => toolSources.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    /** `<sourceSlug>__<name>`; the name the model and MCP clients address. */
    qualifiedName: varchar('qualified_name', { length: 64 }).notNull(),
    description: text('description').notNull().default(''),
    inputSchema: jsonb('input_schema')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ type: 'object' }),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
    annotations: jsonb('annotations').$type<Record<string, unknown>>().notNull().default({}),
    /** Discovery proposes 1 (read-only annotations) or 3; a human may settle on 2. */
    proposedTier: smallint('proposed_tier').notNull(),
    tier: smallint('tier').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    reviewNeeded: boolean('review_needed').notNull().default(false),
    /** sha256 of the canonical definition — drift detector for Tier-3 intents. */
    revision: text('revision').notNull(),
    lastError: text('last_error'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceNameUq: uniqueIndex('tool_source_tools_source_name_uq').on(table.sourceId, table.name),
    orgEnabledIdx: index('tool_source_tools_org_enabled_idx')
      .on(table.orgId)
      .where(sql`${table.enabled} AND ${table.removedAt} IS NULL`),
    partnerEnabledIdx: index('tool_source_tools_partner_enabled_idx')
      .on(table.partnerId)
      .where(sql`${table.enabled} AND ${table.removedAt} IS NULL`),
    sourceIdIdx: index('tool_source_tools_source_id_idx').on(table.sourceId),
  }),
);

export type ToolSourceRow = typeof toolSources.$inferSelect;
export type ToolSourceToolRow = typeof toolSourceTools.$inferSelect;
