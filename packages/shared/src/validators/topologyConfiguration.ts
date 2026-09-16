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
