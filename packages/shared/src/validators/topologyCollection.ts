import { z } from 'zod';
import { collectionOutcomeSchema } from './topology';
import { topologyCidrSchema, topologyDigestSchema, topologyFamilySchema, topologyIpSchema, topologyMacSchema, topologyPortSchema, topologyReasonSchema, topologySequenceSchema, topologyTimestampSchema, topologyUint32Schema, topologyUtf8KeySchema, topologyHostnameSchema, topologyWireGuard } from './topologyPrimitives';
export { topologySequenceSchema, topologyCidrSchema } from './topologyPrimitives';
export const NETWORK_CONTEXT_MAX_BYTES = 512 * 1024;
const key = topologyUtf8KeySchema;
const uint = topologyUint32Schema;
const family = topologyFamilySchema;
const zone = key.nullable();
function addressScope(v: { address: string; zone: string | null; family?: string }, ctx: z.RefinementCtx) {
  const ipv6 = v.address.includes(':');
  if ((v.family && v.family !== (ipv6 ? 'ipv6' : 'ipv4')) || (!ipv6 && v.zone !== null)) ctx.addIssue({ code: 'custom', message: 'Address family/zone mismatch' });
  if (/^fe[89ab]/i.test(v.address) && ipv6 && !v.zone) ctx.addIssue({ code: 'custom', message: 'Link-local address requires zone' });
}
export const topologyAddressRowSchema = z.object({
  address: topologyIpSchema, prefixLength: z.number().int().min(0).max(128), family, zone,
  state: z.enum(['preferred', 'deprecated', 'tentative', 'duplicate', 'unknown']),
  assignment: z.enum(['dhcp', 'static', 'slaac', 'link_local', 'unknown']),
}).superRefine((v, ctx) => {
  addressScope(v, ctx);
  if (v.family === 'ipv4' && v.prefixLength > 32) ctx.addIssue({ code: 'custom', message: 'IPv4 prefix exceeds 32' });
});
export const topologyInterfaceRowSchema = z.object({
  rowKey: key, interfaceKey: key, osIndex: uint, name: key,
  kind: z.enum(['ethernet', 'wifi', 'tunnel', 'bridge', 'cellular', 'virtual', 'other', 'unknown']),
  adminState: z.enum(['up', 'down', 'unknown']), operState: z.enum(['up', 'down', 'unknown']), mtu: uint.nullable(),
  addresses: z.array(topologyAddressRowSchema).max(1024), permanentMac: topologyMacSchema.optional(), currentMac: topologyMacSchema.optional(), parentInterfaceKey: key.optional(),
});
export const topologyNextHopSchema = z.object({ address: topologyIpSchema.nullable(), zone, interfaceKey: key.nullable(), weight: uint.nullable() }).superRefine((v, ctx) => {
  if (v.address) {
    addressScope({ ...v, address: v.address }, ctx);
    if (v.address === '0.0.0.0' || v.address === '::') ctx.addIssue({ code: 'custom', message: 'Unspecified next hop must be represented as on-link null' });
  }
  else if (v.zone !== null) ctx.addIssue({ code: 'custom', message: 'Null address cannot have zone' });
});
export const topologyRouteRowSchema = z.object({
  rowKey: key, family, destinationPrefix: topologyCidrSchema, interfaceKey: key.nullable(), tableKey: key,
  routeType: z.enum(['unicast', 'on_link', 'local', 'blackhole', 'unreachable', 'prohibit', 'other']), metric: uint.nullable(),
  nextHops: z.array(topologyNextHopSchema).max(64), osFlags: uint, sourcePrefix: topologyCidrSchema.optional(), protocol: key.optional(), expiresInSeconds: uint.optional(),
}).superRefine((v, ctx) => {
  for (const ip of [v.destinationPrefix, v.sourcePrefix, ...v.nextHops.map(h => h.address)].filter((x): x is string => !!x)) {
    if (ip.includes(':') !== (v.family === 'ipv6')) ctx.addIssue({ code: 'custom', message: 'Route family mismatch' });
  }
  for (const hop of v.nextHops) if (hop.address === null && v.routeType !== 'on_link' && !hop.interfaceKey && !v.interfaceKey) ctx.addIssue({ code: 'custom', message: 'Null next hop needs on-link type or explicit interface' });
});
export const topologyRuleSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), prefix: topologyCidrSchema }), z.object({ kind: z.literal('destination'), prefix: topologyCidrSchema }),
  z.object({ kind: z.literal('inputInterface'), interfaceKey: key }), z.object({ kind: z.literal('outputInterface'), interfaceKey: key }),
  z.object({ kind: z.literal('fwmark'), value: uint, mask: uint }),
  z.object({ kind: z.literal('uidRange'), start: uint, end: uint }).refine(v => v.start <= v.end, 'Reversed UID range'),
]);
export const topologyRuleRowSchema = z.object({
  rowKey: key, priority: uint, tableKey: key.nullable(), action: z.enum(['lookup', 'blackhole', 'unreachable', 'prohibit', 'goto', 'other']),
  selectors: z.array(topologyRuleSelectorSchema).max(64), selectorCoverage: z.enum(['complete', 'partial']), unsupportedSelectorKinds: z.array(key).max(64).optional(),
}).refine(v => !v.unsupportedSelectorKinds?.length || v.selectorCoverage === 'partial', 'Unsupported selectors require partial coverage');
export const topologyResolverRowSchema = z.object({
  rowKey: key, address: topologyIpSchema, zone, interfaceKey: key.nullable(), isLocalStub: z.boolean(), port: topologyPortSchema,
  transport: z.enum(['udp_tcp', 'tls', 'https', 'unknown']), domains: z.array(z.object({ name: z.union([z.literal('.'), topologyHostnameSchema]), routeOnly: z.boolean() })).max(64),
  mechanism: z.enum(['ip_helper', 'systemd_resolved', 'network_manager', 'resolv_conf', 'system_configuration', 'scutil']), serverName: topologyHostnameSchema.optional(),
}).superRefine(addressScope);
export const topologyNeighborRowSchema = z.object({
  rowKey: key, address: topologyIpSchema, family, zone, interfaceKey: key, mac: topologyMacSchema.nullable(),
  state: z.enum(['reachable', 'stale', 'delay', 'probe', 'incomplete', 'failed', 'permanent', 'unknown']), isRouter: z.boolean().nullable(),
}).superRefine(addressScope);
function section<K extends string, S extends z.ZodType<{ rowKey: string }>>(kind: K, row: S, limit: number) {
  return z.object({ kind: z.literal(kind), contextKey: key, addressFamily: family.optional(), contentDigest: topologyDigestSchema,
    outcome: collectionOutcomeSchema, reasonCode: topologyReasonSchema.optional(), rowCount: uint, omittedRowCount: uint.optional(), rows: z.array(row).max(limit),
  }).superRefine((v, ctx) => {
    if (v.rowCount !== v.rows.length) ctx.addIssue({ code: 'custom', message: 'rowCount mismatch' });
    if (new Set(v.rows.map(r => r.rowKey)).size !== v.rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate row key' });
    if ((v.omittedRowCount ?? 0) > 0 && (v.outcome !== 'partial' || v.reasonCode !== 'limit_exceeded')) ctx.addIssue({ code: 'custom', message: 'Omitted rows require partial limit_exceeded' });
    if (['failed', 'unsupported', 'not_attempted'].includes(v.outcome) && v.rows.length) ctx.addIssue({ code: 'custom', message: 'Outcome cannot contain positive rows' });
  });
}
export const topologyContextSectionSchema = z.discriminatedUnion('kind', [
  section('interfaces', topologyInterfaceRowSchema, 128), section('routes', topologyRouteRowSchema, 2048), section('rules', topologyRuleRowSchema, 512),
  section('resolvers', topologyResolverRowSchema, 128), section('neighbors', topologyNeighborRowSchema, 4096),
]);
const envelope = {
  version: z.literal(1), producerEpoch: key, snapshotId: z.uuid(), sequence: topologySequenceSchema, capturedAt: topologyTimestampSchema,
  captureAgeAtSendMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), expectedIntervalSeconds: z.number().int().min(60).max(86400), contentDigest: topologyDigestSchema,
};
export const networkContextFullSchema = z.object({ ...envelope, reportKind: z.literal('full'),
  capabilities: z.array(z.object({ name: key, version: z.number().int().min(1).max(65535), supported: z.boolean() })).max(128),
  contextManifest: z.object({ outcome: collectionOutcomeSchema, contexts: z.array(z.object({ contextKey: key, families: z.array(family).min(1).max(2).refine(v => new Set(v).size === v.length, 'Duplicate family') })).max(128) }),
  sections: z.array(topologyContextSectionSchema).max(128 * 5 * 3),
}).superRefine((v, ctx) => {
  const contexts = new Set(v.contextManifest.contexts.map(c => c.contextKey));
  if (contexts.size !== v.contextManifest.contexts.length) ctx.addIssue({ code: 'custom', message: 'Duplicate context' });
  if (new Set(v.capabilities.map(c => c.name)).size !== v.capabilities.length) ctx.addIssue({ code: 'custom', message: 'Duplicate capability' });
  const sections = new Set<string>();
  const counts = new Map<string, number>();
  const limits: Record<string, number> = { interfaces: 128, addresses: 1024, routes: 2048, rules: 512, resolvers: 128, neighbors: 4096 };
  for (const s of v.sections) {
    const identity = JSON.stringify([s.contextKey, s.kind, s.addressFamily ?? null]);
    if (sections.has(identity) || !contexts.has(s.contextKey)) ctx.addIssue({ code: 'custom', message: 'Duplicate or undeclared section scope' });
    sections.add(identity);
    if (s.addressFamily && !v.contextManifest.contexts.find(c => c.contextKey === s.contextKey)?.families.includes(s.addressFamily)) ctx.addIssue({ code: 'custom', message: 'Undeclared family' });
    for (const [kind, count] of [[s.kind, s.rows.length], ...(s.kind === 'interfaces' ? [['addresses', s.rows.reduce((n, r) => n + r.addresses.length, 0)]] : [])] as [string, number][]) {
      const k = JSON.stringify([s.contextKey, kind]); const total = (counts.get(k) ?? 0) + count; counts.set(k, total);
      if (total > limits[kind]!) ctx.addIssue({ code: 'custom', message: `Context ${kind} limit exceeded` });
    }
  }
});
export const networkContextUnchangedSchema = z.object({ ...envelope, reportKind: z.literal('unchanged'), baseSnapshotId: z.uuid(), outcome: z.never().optional(), sections: z.never().optional(), capabilities: z.never().optional(), contextManifest: z.never().optional() });
export const networkContextV1Schema = topologyWireGuard(NETWORK_CONTEXT_MAX_BYTES).pipe(z.discriminatedUnion('reportKind', [networkContextFullSchema, networkContextUnchangedSchema]));
/** Version rejection is report-local; callers retain the enclosing legacy heartbeat. */
export function parseNetworkContextReport(value: unknown) {
  if (value && typeof value === 'object' && 'version' in value && value.version !== 1) return { accepted: false as const, reason: 'unsupported_major_version' as const };
  const result = networkContextV1Schema.safeParse(value);
  return result.success ? { accepted: true as const, report: result.data } : { accepted: false as const, reason: 'invalid_report' as const, issues: result.error.issues };
}
