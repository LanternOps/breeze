import './topologyZod';
import { z } from 'zod';
import { topologyFamilySchema, topologyHostnameSchema, topologyIpSchema, topologyJsonBytes, topologyPortSchema, topologyUtf8KeySchema } from './topologyPrimitives';
export const topologyStableKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const topologyRecipeIdSchema = z.enum(['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity']);
const families = z.array(topologyFamilySchema).min(1).max(2).refine(v => new Set(v).size === v.length, 'Duplicate family');
const commonTarget = { label: topologyUtf8KeySchema, enabled: z.boolean(), families, provider: topologyUtf8KeySchema.nullable(), independenceLabel: topologyUtf8KeySchema.nullable() };
export const topologyTargetDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({ ...commonTarget, kind: z.literal('dns_name'), hostname: topologyHostnameSchema, expectedAddresses: z.array(topologyIpSchema).max(4), resolver: z.literal('configured_dns') }).strict(),
  z.object({ ...commonTarget, kind: z.literal('tcp'), host: z.union([topologyIpSchema, topologyHostnameSchema]), port: topologyPortSchema }).strict(),
  z.object({ ...commonTarget, kind: z.literal('https'), hostname: topologyHostnameSchema, port: topologyPortSchema,
    path: z.string().min(1).max(2048).regex(/^\/(?!\/)[^\s#\\]*$/), method: z.enum(['GET', 'HEAD']), expectedStatus: z.number().int().min(100).max(599),
    maxRedirects: z.number().int().min(0).max(2), proxyMode: z.enum(['direct', 'configured']),
  }).strict(),
]);
export const topologyTargetTombstoneSchema = z.object({ kind: z.literal('tombstone') }).strict();
export const topologyPolicyDefinitionSchema = z.object({
  kind: z.literal('policy'), enabled: z.boolean(), recipeId: topologyRecipeIdSchema, recipeVersion: z.literal(1),
  subject: z.enum(['reported_gateway', 'configured_dns', 'configured_target']), targetKeys: z.array(topologyStableKeySchema).max(64).refine(v => new Set(v).size === v.length, 'Duplicate target key'),
  families, origin: z.enum(['original_reporter', 'eligible_collector']), intervalSeconds: z.number().int().min(60).max(3600), jitterPercent: z.literal(10),
  alertsEnabled: z.boolean(), failureThreshold: z.number().int().min(1).max(100), recoveryThreshold: z.number().int().min(1).max(100),
}).strict();
const namedTargets = z.record(topologyStableKeySchema, z.union([topologyTargetDefinitionSchema, topologyTargetTombstoneSchema])).refine(v => Object.keys(v).length <= 64, 'At most 64 targets');
const namedPolicies = z.record(topologyStableKeySchema, z.union([topologyPolicyDefinitionSchema, topologyTargetTombstoneSchema])).refine(v => Object.keys(v).length <= 64, 'At most 64 policies');
/** Layer payload: absent scalars inherit. Resolve target references only after all layers merge. */
export const topologyConfigurationSchema = z.object({
  passive: z.object({ enabled: z.boolean().optional(), intervalSeconds: z.number().int().min(60).max(86400).optional(), neighbors: z.boolean().optional(), routingRules: z.boolean().optional() }).strict().optional(),
  targets: namedTargets.default({}), policies: namedPolicies.default({}), outboundEnabled: z.boolean().optional(),
}).strict().refine(v => topologyJsonBytes(v) <= 256 * 1024, 'Configuration exceeds 256 KiB');
export const topologyResolvedConfigurationSchema = topologyConfigurationSchema.superRefine((v, ctx) => {
  for (const [key, policy] of Object.entries(v.policies)) {
    if (policy.kind === 'tombstone') continue;
    for (const targetKey of policy.targetKeys) if (!v.targets[targetKey] || v.targets[targetKey]?.kind === 'tombstone') ctx.addIssue({ code: 'custom', path: ['policies', key, 'targetKeys'], message: `Unresolved target ${targetKey}` });
  }
});
export const topologyCapabilities = { passiveContext: true, explicitDiagnostics: true, recurringMonitoring: false, physicalEnrichment: false } as const;
export function assertM1PolicyActivation(enabled: boolean): void {
  if (enabled) throw Object.assign(new Error('capability_unavailable'), { code: 'capability_unavailable' });
}

// HTTP envelopes expose current capabilities and configuration, never execution authority.
const revision = z.string().regex(/^(0|[1-9]\d*)$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);
const capability = z.object({ available: z.boolean(), reason: reason.nullable() }).strict().refine(v => v.available ? v.reason === null : v.reason !== null, 'Unavailable capability needs a reason');
export const topologyRuntimeCapabilitiesSchema = z.object({ materialization: capability, ui: capability, collection: capability, physical: capability, interfaceHealth: capability, diagnostics: capability, ai: capability, recurringMonitoring: capability }).strict();
export const topologyConfigurationEffectSchema = z.object({
  field: z.string().min(1).max(255), action: z.enum(['add', 'replace', 'remove', 'inherit', 'disable', 'require_rearm']),
  capability: z.enum(['passiveSettings', 'monitoringTargets', 'recurringMonitoring']), reason: reason.nullable(),
}).strict();
export const resolvedTopologySettingsSchema = z.object({
  settings: topologyResolvedConfigurationSchema, digest,
  provenance: z.record(z.string().min(1).max(255), z.object({ layer: z.enum(['defaults', 'partner', 'organization', 'site']), versionId: z.uuid().nullable() }).strict()),
  validationEffects: z.array(topologyConfigurationEffectSchema).max(512),
}).strict();
export const topologySiteSettingsSchema = z.object({
  siteId: z.uuid(), settingsRevision: revision,
  flags: z.object({ materialization: z.boolean(), ui: z.boolean(), physical: z.boolean(), interfaceHealth: z.boolean(), diagnostics: z.boolean(), ai: z.boolean() }).strict(),
  capabilities: topologyRuntimeCapabilitiesSchema,
  permissions: z.object({ canEdit: z.boolean(), canDiagnose: z.boolean(), canConfigureMonitoring: z.boolean() }).strict(),
  resolved: resolvedTopologySettingsSchema,
  binding: z.object({ partnerVersionId: z.uuid().nullable(), orgVersionId: z.uuid().nullable(), bindingRevision: revision, defaultsVersion: z.number().int().positive(), schemaVersion: z.literal(1), resolverVersion: z.number().int().positive(), overrides: topologyConfigurationSchema }).strict(),
}).strict();
export const topologySiteSettingsPatchSchema = z.object({ expectedRevision: revision, overrides: topologyConfigurationSchema }).strict();
export const topologyTemplateVersionSchema = z.object({
  id: z.uuid(), templateId: z.uuid(), ownerScope: z.enum(['partner', 'organization']), key: topologyStableKeySchema, name: topologyUtf8KeySchema,
  version: z.number().int().positive(), revision, state: z.enum(['draft', 'published']), schemaVersion: z.literal(1), defaultsVersion: z.number().int().positive(), resolverVersion: z.number().int().positive(),
  payload: topologyConfigurationSchema, contentDigest: digest, publishedAt: z.string().datetime().nullable(),
}).strict().refine(v => (v.state === 'published') === (v.publishedAt !== null), 'Published version requires publication time');
export const topologyTemplateVersionListSchema = z.object({ items: z.array(topologyTemplateVersionSchema).max(200), nextCursor: z.string().min(1).max(2048).nullable() }).strict();
export const topologyTemplateOptionsSchema = topologyTemplateVersionListSchema.refine(v => v.items.every(i => i.state === 'published'), 'Site options contain only published versions');
export const topologyTemplatePreviewRequestSchema = z.object({
  partnerVersionId: z.uuid().nullable(), orgVersionId: z.uuid().nullable(),
  sites: z.array(z.object({ siteId: z.uuid(), expectedBindingRevision: revision, overrides: topologyConfigurationSchema.optional(), enableRecurring: z.boolean().default(false) }).strict()).min(1).max(500),
}).strict().refine(v => new Set(v.sites.map(s => s.siteId)).size === v.sites.length, 'Duplicate site');
export const topologyTemplatePreviewSchema = z.object({
  token: z.string().min(1).max(4096), expiresAt: z.string().datetime(),
  sites: z.array(z.object({ siteId: z.uuid(), expectedBindingRevision: revision, effects: z.array(topologyConfigurationEffectSchema).max(512), errors: z.array(z.object({ code: reason, field: z.string().max(255).nullable() }).strict()).max(128) }).strict()).max(500),
}).strict();
export const topologyTemplateApplyRequestSchema = z.object({ token: z.string().min(1).max(4096) }).strict();
export const topologyTemplateSiteOutcomeSchema = z.object({ siteId: z.uuid(), state: z.enum(['queued', 'running', 'applied', 'conflict', 'failed']), code: reason.nullable(), settingsRevision: revision.nullable() }).strict();
export const topologyTemplateApplicationSchema = z.object({ id: z.uuid(), state: z.enum(['queued', 'running', 'completed', 'partial', 'failed']), sites: z.array(topologyTemplateSiteOutcomeSchema).max(500) }).strict();
