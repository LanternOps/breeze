import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, timestamp, bigint, integer, jsonb, uniqueIndex, foreignKey, check } from 'drizzle-orm/pg-core';
import type { TopologyConfigurationPayload } from '@breeze/shared';
import { organizations, partners, sites } from './orgs';

export const topologyConfigTemplates = pgTable('topology_config_templates', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').references(() => organizations.id, {onDelete:'cascade'}), partnerId: uuid('partner_id').references(() => partners.id, {onDelete:'cascade'}),
  key: varchar('key',{length:64}).notNull(), name: varchar('name',{length:255}).notNull(), description: varchar('description',{length:2048}),
  revision: bigint('revision',{mode:'bigint'}).notNull().default(1n), lifecycle: varchar('lifecycle',{length:16}).notNull().default('active'),
  createdBy: uuid('created_by'), updatedBy: uuid('updated_by'), createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
}, t=>[
 check('topology_config_templates_one_owner_chk',sql`num_nonnulls(org_id,partner_id)=1`), check('topology_config_templates_lifecycle_chk',sql`lifecycle IN ('active','archived','revoked')`), check('topology_config_templates_revision_chk',sql`revision >= 0`),
 uniqueIndex('topology_config_templates_org_key_uniq').on(t.orgId,t.key).where(sql`org_id IS NOT NULL`), uniqueIndex('topology_config_templates_partner_key_uniq').on(t.partnerId,t.key).where(sql`partner_id IS NOT NULL`),
 uniqueIndex('topology_config_templates_org_name_uniq').on(t.orgId,t.name).where(sql`org_id IS NOT NULL`), uniqueIndex('topology_config_templates_partner_name_uniq').on(t.partnerId,t.name).where(sql`partner_id IS NOT NULL`),
]);
export const topologyConfigTemplateVersions = pgTable('topology_config_template_versions', {
 id:uuid('id').primaryKey().defaultRandom(),templateId:uuid('template_id').notNull().references(()=>topologyConfigTemplates.id,{onDelete:'cascade'}),orgId:uuid('org_id').references(()=>organizations.id,{onDelete:'cascade'}),partnerId:uuid('partner_id').references(()=>partners.id,{onDelete:'cascade'}),
 version:integer('version').notNull(),revision:bigint('revision',{mode:'bigint'}).notNull().default(1n),state:varchar('state',{length:16}).notNull().default('draft'),
 schemaVersion:integer('schema_version').notNull().default(1),resolverVersion:integer('resolver_version').notNull().default(1),defaultsVersion:integer('defaults_version').notNull().default(1),
 payload:jsonb('payload').$type<TopologyConfigurationPayload>().notNull(),contentDigest:varchar('content_digest',{length:64}).notNull(),publishedAt:timestamp('published_at',{withTimezone:true}),publishedBy:uuid('published_by'),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
 check('topology_config_template_versions_one_owner_chk',sql`num_nonnulls(org_id,partner_id)=1`),check('topology_config_template_versions_state_chk',sql`state IN ('draft','published') AND (state='published')=(published_at IS NOT NULL)`),
 check('topology_config_template_versions_version_chk',sql`version>0 AND revision>=0 AND schema_version>0 AND resolver_version>0 AND defaults_version>0`),
 check('topology_config_template_versions_payload_chk',sql`jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144`),uniqueIndex('topology_config_template_versions_number_uniq').on(t.templateId,t.version),
]);
export const topologySiteTemplateBindings = pgTable('topology_site_template_bindings', {
 id:uuid('id').primaryKey().defaultRandom(),orgId:uuid('org_id').notNull(),siteId:uuid('site_id').notNull(),partnerVersionId:uuid('partner_version_id').references(()=>topologyConfigTemplateVersions.id,{onDelete:'set null'}),orgVersionId:uuid('org_version_id').references(()=>topologyConfigTemplateVersions.id,{onDelete:'set null'}),
 overrides:jsonb('overrides').$type<TopologyConfigurationPayload>().notNull().default({targets:{},policies:{}}),defaultsVersion:integer('defaults_version').notNull().default(1),schemaVersion:integer('schema_version').notNull().default(1),resolverVersion:integer('resolver_version').notNull().default(1),revision:bigint('revision',{mode:'bigint'}).notNull().default(1n),
 effectiveDigest:varchar('effective_digest',{length:64}),applyOperationId:uuid('apply_operation_id'),status:varchar('status',{length:24}).notNull().default('unbound'),updatedBy:uuid('updated_by'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
 uniqueIndex('topology_site_template_bindings_site_uniq').on(t.orgId,t.siteId),foreignKey({name:'topology_site_template_bindings_site_fk',columns:[t.siteId,t.orgId],foreignColumns:[sites.id,sites.orgId]}).onDelete('cascade'),
 check('topology_site_template_bindings_revision_chk',sql`revision>=0 AND defaults_version>0 AND schema_version>0 AND resolver_version>0`),check('topology_site_template_bindings_overrides_chk',sql`jsonb_typeof(overrides)='object' AND octet_length(overrides::text)<=262144`),
]);
