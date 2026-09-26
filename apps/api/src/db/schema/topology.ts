import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, timestamp, bigint, integer, boolean, jsonb, doublePrecision, primaryKey, uniqueIndex, index, foreignKey, check } from 'drizzle-orm/pg-core';
import type { NodeKind, RelationshipKind, Lifecycle, Directness, Confidence, EvidenceClass, TopologyView } from '@breeze/shared';
import { sites } from './orgs';
import { topologyInterfaces } from './topologyCollections';
import { devices } from './devices';
import { discoveredAssets, topologyManualNodes } from './discovery';

/** Server-owned original identity inputs retained for rekeying after an org merge.
 * Values are bounded/validated by the canonical identity builders before writes. */
export interface TopologyIdentityMaterial {
  version: 1;
  kind: NodeKind | RelationshipKind;
  sourceKey: string;
}
export interface TopologyNodeAttributes { label?: string; notes?: string; prefix?: string; addressFamily?: 4 | 6; }
/** Physical (M2) resolution/selection material; bounded and strict in publish.ts. */
export interface TopologyPhysicalRelationshipAttributes {
  resolution?: 'resolved' | 'unresolved'; subjectAuthority?: string;
  remoteChassis?: { subtype: string; value: string }; remotePort?: { subtype: string; value: string };
  localPort?: { namespace: 'if_index' | 'if_name' | 'bridge_port' | 'lldp_local' | 'controller_port'; value: string; resolvedInterfaceKey: string | null };
  remotePortRef?: { namespace: 'if_index' | 'if_name' | 'bridge_port' | 'lldp_local' | 'controller_port'; value: string; resolvedInterfaceKey: string | null };
  bridgeContext?: string; fdbId?: number | null; vlanIds?: number[];
  controllerSiteId?: string; controllerDeviceId?: string; uplinkPortIndex?: number;
  fdbSelection?: 'selected' | 'competing' | 'excluded' | 'none'; alternativeRelationshipIds?: string[];
}
export interface TopologyRelationshipAttributes { label?: string; notes?: string; method?: 'manual' | 'legacy' | 'os_network_context' | 'lldp' | 'cdp' | 'fdb' | 'unifi'; createdBy?: string; physical?: TopologyPhysicalRelationshipAttributes; }
export interface TopologyBindingProvenance { method?: 'inventory' | 'accepted_link' | 'manual' | 'legacy'; sourceId?: string; createdBy?: string; }

// SQL owns DEFERRABLE INITIALLY IMMEDIATE; Drizzle does not expose that option.

export const topologySiteState = pgTable('topology_site_state', {
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  dirtyRevision: bigint('dirty_revision', { mode: 'bigint' }).notNull().default(0n),
  materializedInputRevision: bigint('materialized_input_revision', { mode: 'bigint' }).notNull().default(0n),
  graphRevision: bigint('graph_revision', { mode: 'bigint' }).notNull().default(0n),
  healthRevision: bigint('health_revision', { mode: 'bigint' }).notNull().default(0n),
  buildFence: bigint('build_fence', { mode: 'bigint' }).notNull().default(0n),
  settingsRevision: bigint('settings_revision', { mode: 'bigint' }).notNull().default(0n),
  effectiveSettings: jsonb('effective_settings').$type<Record<string, unknown>>().notNull().default({}),
  settingsDigest: varchar('settings_digest', { length: 64 }),
  disabledSourceReasons: jsonb('disabled_source_reasons').$type<Record<string, string>>().notNull().default({}),
  /** D15.2: bumped by identity writers (bindings, interfaces, merges); physical
   * re-resolution runs while it exceeds resolved_identity_revision. */
  identityRevision: bigint('identity_revision', { mode: 'bigint' }).notNull().default(0n),
  resolvedIdentityRevision: bigint('resolved_identity_revision', { mode: 'bigint' }).notNull().default(0n),
  lastBuildStatus: varchar('last_build_status', { length: 32 }),
  lastBuildAt: timestamp('last_build_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_site_state_pkey', columns: [table.orgId, table.siteId] }),
  check('topology_site_state_dirty_revision_chk', sql`dirty_revision >= 0`),
  check('topology_site_state_materialized_input_revision_chk', sql`materialized_input_revision >= 0`),
  check('topology_site_state_graph_revision_chk', sql`graph_revision >= 0`),
  check('topology_site_state_health_revision_chk', sql`health_revision >= 0`),
  check('topology_site_state_build_fence_chk', sql`build_fence >= 0`),
  check('topology_site_state_settings_revision_chk', sql`settings_revision >= 0`),
  check('topology_site_state_identity_revision_chk', sql`identity_revision >= 0 AND resolved_identity_revision >= 0`),
  check('topology_site_state_effective_settings_chk', sql`jsonb_typeof(effective_settings) = 'object' AND octet_length(effective_settings::text) <= 262144`),
  check('topology_site_state_disabled_source_reasons_chk', sql`jsonb_typeof(disabled_source_reasons) = 'object' AND octet_length(disabled_source_reasons::text) <= 262144`),
  foreignKey({ name: 'topology_site_state_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
]);

export const topologyNodes = pgTable('topology_nodes', {
  id: uuid('id').notNull().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  identityKey: varchar('identity_key', { length: 256 }).notNull(),
  identityMaterial: jsonb('identity_material').$type<TopologyIdentityMaterial>().notNull(),
  kind: varchar('kind', { length: 24 }).$type<NodeKind>().notNull(),
  role: varchar('role', { length: 64 }),
  labelOverride: varchar('label_override', { length: 255 }),
  attributes: jsonb('attributes').$type<TopologyNodeAttributes>().notNull().default({}),
  firstObservedAt: timestamp('first_observed_at', { withTimezone: true }),
  lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
  lifecycle: varchar('lifecycle', { length: 16 }).$type<Lifecycle>().notNull().default("active"),
  aliasTargetId: uuid('alias_target_id'),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n),
  legacySourceType: varchar('legacy_source_type', { length: 40 }),
  legacySourceId: uuid('legacy_source_id'),
  legacySourceRevision: bigint('legacy_source_revision', { mode: 'bigint' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_nodes_pkey', columns: [table.id] }),
  check('topology_nodes_kind_chk', sql`kind IN ('endpoint','network','gateway','internet','manual')`),
  check('topology_nodes_lifecycle_chk', sql`lifecycle IN ('active','withdrawn','archived')`),
  check('topology_node_alias_self_chk', sql`alias_target_id IS NULL OR alias_target_id <> id`),
  check('topology_nodes_identity_material_chk', sql`jsonb_typeof(identity_material) = 'object' AND identity_material ?& ARRAY['version','kind','sourceKey'] AND identity_material - ARRAY['version','kind','sourceKey'] = '{}'::jsonb AND identity_material->'version' = '1'::jsonb AND jsonb_typeof(identity_material->'kind') = 'string' AND identity_material->>'kind' = kind AND jsonb_typeof(identity_material->'sourceKey') = 'string' AND length(identity_material->>'sourceKey') BETWEEN 1 AND 8192 AND octet_length(identity_material::text) <= 16384`),
  check('topology_nodes_attributes_chk', sql`jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 262144`),
  check('topology_nodes_revision_chk', sql`revision >= 0`),
  check('topology_nodes_legacy_source_revision_chk', sql`legacy_source_revision >= 0`),
  uniqueIndex('topology_nodes_id_org_site_uniq').on(table.id, table.orgId, table.siteId),
  uniqueIndex('topology_nodes_identity_uniq').on(table.orgId, table.siteId, table.identityKey),
  foreignKey({ name: 'topology_nodes_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_node_alias_scope_fk', columns: [table.aliasTargetId, table.orgId, table.siteId], foreignColumns: [table.id, table.orgId, table.siteId] }).onDelete('no action'),
]);

export const topologyNodeBindings = pgTable('topology_node_bindings', {
  id: uuid('id').notNull().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  deviceId: uuid('device_id'),
  discoveredAssetId: uuid('discovered_asset_id'),
  manualNodeId: uuid('manual_node_id'),
  provenance: jsonb('provenance').$type<TopologyBindingProvenance>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_node_bindings_pkey', columns: [table.id] }),
  check('topology_binding_inventory_xor_chk', sql`num_nonnulls(device_id, discovered_asset_id, manual_node_id) = 1`),
  check('topology_node_bindings_provenance_chk', sql`jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 262144`),
  uniqueIndex('topology_binding_device_id_uniq').on(table.deviceId).where(sql`device_id IS NOT NULL`),
  uniqueIndex('topology_binding_discovered_asset_id_uniq').on(table.discoveredAssetId).where(sql`discovered_asset_id IS NOT NULL`),
  uniqueIndex('topology_binding_manual_node_id_uniq').on(table.manualNodeId).where(sql`manual_node_id IS NOT NULL`),
  foreignKey({ name: 'topology_node_bindings_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_binding_node_scope_fk', columns: [table.nodeId, table.orgId, table.siteId], foreignColumns: [topologyNodes.id, topologyNodes.orgId, topologyNodes.siteId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_binding_device_scope_fk', columns: [table.deviceId, table.orgId, table.siteId], foreignColumns: [devices.id, devices.orgId, devices.siteId] }).onDelete('no action'),
  foreignKey({ name: 'topology_binding_asset_scope_fk', columns: [table.discoveredAssetId, table.orgId, table.siteId], foreignColumns: [discoveredAssets.id, discoveredAssets.orgId, discoveredAssets.siteId] }).onDelete('no action'),
  foreignKey({ name: 'topology_binding_manual_scope_fk', columns: [table.manualNodeId, table.orgId, table.siteId], foreignColumns: [topologyManualNodes.id, topologyManualNodes.orgId, topologyManualNodes.siteId] }).onDelete('no action'),
]);

export const topologyRelationships = pgTable('topology_relationships', {
  id: uuid('id').notNull().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  canonicalKey: varchar('canonical_key', { length: 256 }).notNull(),
  identityMaterial: jsonb('identity_material').$type<TopologyIdentityMaterial>().notNull(),
  kind: varchar('kind', { length: 24 }).$type<RelationshipKind>().notNull(),
  sourceNodeId: uuid('source_node_id').notNull(),
  targetNodeId: uuid('target_node_id').notNull(),
  sourceInterfaceId: uuid('source_interface_id'),
  targetInterfaceId: uuid('target_interface_id'),
  logicalContext: jsonb('logical_context').$type<Record<string, unknown>>().notNull().default({}),
  directness: varchar('directness', { length: 24 }).$type<Directness>().notNull().default("unknown"),
  confidence: varchar('confidence', { length: 16 }).$type<Confidence>().notNull().default("asserted"),
  evidenceClass: varchar('evidence_class', { length: 16 }).$type<EvidenceClass>().notNull().default("manual"),
  lifecycle: varchar('lifecycle', { length: 16 }).$type<Lifecycle>().notNull().default("active"),
  firstSupportedAt: timestamp('first_supported_at', { withTimezone: true }),
  lastSupportedAt: timestamp('last_supported_at', { withTimezone: true }),
  supportCount: bigint('support_count', { mode: 'bigint' }).notNull().default(0n),
  graphRevision: bigint('graph_revision', { mode: 'bigint' }).notNull().default(0n),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n),
  attributes: jsonb('attributes').$type<TopologyRelationshipAttributes>().notNull().default({}),
  legacySourceType: varchar('legacy_source_type', { length: 40 }),
  legacySourceId: uuid('legacy_source_id'),
  legacySourceRevision: bigint('legacy_source_revision', { mode: 'bigint' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: 'topology_relationships_source_interface_fk', columns: [table.sourceInterfaceId, table.sourceNodeId, table.orgId, table.siteId], foreignColumns: [topologyInterfaces.id, topologyInterfaces.ownerNodeId, topologyInterfaces.orgId, topologyInterfaces.siteId] }),
  foreignKey({ name: 'topology_relationships_target_interface_fk', columns: [table.targetInterfaceId, table.targetNodeId, table.orgId, table.siteId], foreignColumns: [topologyInterfaces.id, topologyInterfaces.ownerNodeId, topologyInterfaces.orgId, topologyInterfaces.siteId] }),
  primaryKey({ name: 'topology_relationships_pkey', columns: [table.id] }),
  check('topology_relationships_kind_chk', sql`kind IN ('network_member','default_route','egress_path','physical_link','attachment')`),
  check('topology_relationships_directness_chk', sql`directness IN ('direct','via_unmanaged','unknown')`),
  check('topology_relationships_confidence_chk', sql`confidence IN ('high','medium','low','asserted')`),
  check('topology_relationships_evidence_class_chk', sql`evidence_class IN ('observed','inferred','manual')`),
  check('topology_relationships_lifecycle_chk', sql`lifecycle IN ('active','withdrawn','archived')`),
  check('topology_relationships_identity_material_chk', sql`jsonb_typeof(identity_material) = 'object' AND identity_material ?& ARRAY['version','kind','sourceKey'] AND identity_material - ARRAY['version','kind','sourceKey'] = '{}'::jsonb AND identity_material->'version' = '1'::jsonb AND jsonb_typeof(identity_material->'kind') = 'string' AND identity_material->>'kind' = kind AND jsonb_typeof(identity_material->'sourceKey') = 'string' AND length(identity_material->>'sourceKey') BETWEEN 1 AND 8192 AND octet_length(identity_material::text) <= 16384`),
  check('topology_relationships_logical_context_chk', sql`jsonb_typeof(logical_context) = 'object' AND octet_length(logical_context::text) <= 262144`),
  check('topology_relationships_support_count_chk', sql`support_count >= 0`),
  check('topology_relationships_graph_revision_chk', sql`graph_revision >= 0`),
  check('topology_relationships_revision_chk', sql`revision >= 0`),
  check('topology_relationships_attributes_chk', sql`jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 262144`),
  check('topology_relationships_legacy_source_revision_chk', sql`legacy_source_revision >= 0`),
  uniqueIndex('topology_relationships_id_org_site_uniq').on(table.id, table.orgId, table.siteId),
  uniqueIndex('topology_relationships_canonical_uniq').on(table.orgId, table.siteId, table.canonicalKey),
  foreignKey({ name: 'topology_relationships_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_relationship_source_scope_fk', columns: [table.sourceNodeId, table.orgId, table.siteId], foreignColumns: [topologyNodes.id, topologyNodes.orgId, topologyNodes.siteId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_relationship_target_scope_fk', columns: [table.targetNodeId, table.orgId, table.siteId], foreignColumns: [topologyNodes.id, topologyNodes.orgId, topologyNodes.siteId] }).onDelete('cascade'),
]);

export const topologyLayouts = pgTable('topology_layouts', {
  id: uuid('id').notNull().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  view: varchar('view', { length: 16 }).$type<TopologyView>().notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n),
  algorithm: varchar('algorithm', { length: 64 }),
  algorithmVersion: varchar('algorithm_version', { length: 32 }),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_layouts_pkey', columns: [table.id] }),
  check('topology_layouts_view_chk', sql`view IN ('overview','physical','logical')`),
  check('topology_layouts_revision_chk', sql`revision >= 0`),
  check('topology_layouts_settings_chk', sql`jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 262144`),
  uniqueIndex('topology_layouts_id_org_site_uniq').on(table.id, table.orgId, table.siteId),
  uniqueIndex('topology_layouts_view_uniq').on(table.orgId, table.siteId, table.view),
  foreignKey({ name: 'topology_layouts_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
]);

export const topologyNodePositions = pgTable('topology_node_positions', {
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  layoutId: uuid('layout_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  x: doublePrecision('x').notNull(),
  y: doublePrecision('y').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  positionSource: varchar('position_source', { length: 16 }).$type<'auto' | 'user' | 'legacy'>().notNull().default("auto"),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n),
  updatedBy: uuid('updated_by'),
  legacySourceRevision: bigint('legacy_source_revision', { mode: 'bigint' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_node_positions_pkey', columns: [table.layoutId, table.nodeId] }),
  check('topology_position_coordinates_chk', sql`x BETWEEN -1000000 AND 1000000 AND y BETWEEN -1000000 AND 1000000`),
  check('topology_node_positions_position_source_chk', sql`position_source IN ('auto','user','legacy')`),
  check('topology_node_positions_revision_chk', sql`revision >= 0`),
  check('topology_node_positions_legacy_source_revision_chk', sql`legacy_source_revision >= 0`),
  foreignKey({ name: 'topology_node_positions_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_position_node_scope_fk', columns: [table.nodeId, table.orgId, table.siteId], foreignColumns: [topologyNodes.id, topologyNodes.orgId, topologyNodes.siteId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_position_layout_scope_fk', columns: [table.layoutId, table.orgId, table.siteId], foreignColumns: [topologyLayouts.id, topologyLayouts.orgId, topologyLayouts.siteId] }).onDelete('cascade'),
]);

export const topologyChangeOutbox = pgTable('topology_change_outbox', {
  id: uuid('id').notNull().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  eventKind: varchar('event_kind', { length: 64 }).notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  sourceRevision: bigint('source_revision', { mode: 'bigint' }).notNull().default(0n),
  idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  lastError: varchar('last_error', { length: 1024 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_change_outbox_pkey', columns: [table.id] }),
  check('topology_outbox_attempt_count_chk', sql`attempt_count >= 0`),
  check('topology_change_outbox_source_revision_chk', sql`source_revision >= 0`),
  check('topology_change_outbox_payload_chk', sql`jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144`),
  uniqueIndex('topology_outbox_idempotency_uniq').on(table.orgId, table.siteId, table.idempotencyKey),
  index('topology_outbox_revision_idx').on(table.orgId, table.siteId, table.sourceRevision),
  index('topology_outbox_pending_idx').on(table.nextAttemptAt, table.createdAt).where(sql`delivered_at IS NULL`),
  foreignKey({ name: 'topology_change_outbox_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
]);

/** M2: scoped, reversible hide of one canonical relationship in one view.
 * Canonical traversal/evidence ignore it; only view projections apply it. */
export const topologyViewExclusions = pgTable('topology_view_exclusions', {
  id: uuid('id').notNull().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  relationshipId: uuid('relationship_id').notNull(),
  view: varchar('view', { length: 16 }).$type<TopologyView>().notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  createdBy: uuid('created_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'topology_view_exclusions_pkey', columns: [table.id] }),
  check('topology_view_exclusions_view_chk', sql`view IN ('overview','physical','logical')`),
  check('topology_view_exclusions_reason_chk', sql`char_length(reason) BETWEEN 1 AND 500`),
  uniqueIndex('topology_view_exclusions_active_uniq').on(table.orgId, table.siteId, table.relationshipId, table.view).where(sql`revoked_at IS NULL`),
  index('topology_view_exclusions_relationship_idx').on(table.relationshipId, table.orgId, table.siteId),
  foreignKey({ name: 'topology_view_exclusions_site_scope_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_view_exclusions_relationship_scope_fk', columns: [table.relationshipId, table.orgId, table.siteId], foreignColumns: [topologyRelationships.id, topologyRelationships.orgId, topologyRelationships.siteId] }).onDelete('cascade'),
]);
