import { describe, expect, it } from 'vitest';
import { networkContextFixture } from '../testing/topologyFixtures';
import { networkContextV1Schema, parseNetworkContextReport, topologySequenceSchema, topologyAddressRowSchema, topologyRouteRowSchema, topologyRuleRowSchema } from './topologyCollection';
import { topologyCidrSchema, topologyIpSchema, topologyMacSchema } from './topologyPrimitives';
describe('network context v1', () => {
  it('round trips all five sections and preserves uint64 precision', () => {
    const report = networkContextFixture(); report.sequence = '18446744073709551615';
    expect(networkContextV1Schema.parse(report)).toEqual(report);
  });
  it.each(['-1', '01', '1.5', '18446744073709551616', '', 'abc', 1, null])('rejects sequence %s without throwing', v => expect(topologySequenceSchema.safeParse(v).success).toBe(false));
  it('accepts an unchanged confirmation but rejects coverage promotion', () => {
    const f = networkContextFixture(); const { capabilities, contextManifest, sections, ...e } = f;
    const unchanged = { ...e, reportKind: 'unchanged', baseSnapshotId: f.snapshotId };
    expect(networkContextV1Schema.safeParse(unchanged).success).toBe(true);
    expect(networkContextV1Schema.safeParse({ ...unchanged, outcome: 'complete' }).success).toBe(false);
  });
  it.each(['orgId', 'siteId', 'agentId', 'producerId', 'deviceId', 'partnerId'])('rejects uploaded %s anywhere', k => {
    expect(networkContextV1Schema.safeParse({ ...networkContextFixture(), [k]: 'forged' }).success).toBe(false);
    const f = networkContextFixture(); Object.assign(f.sections[0]!, { [k]: 'forged' });
    expect(networkContextV1Schema.safeParse(f).success).toBe(false);
  });
  it('ignores minor full fields only after size validation', () => {
    expect(networkContextV1Schema.parse({ ...networkContextFixture(), minor: 1 })).not.toHaveProperty('minor');
    expect(networkContextV1Schema.safeParse({ ...networkContextFixture(), minor: 'x'.repeat(512 * 1024) }).success).toBe(false);
    expect(parseNetworkContextReport({ version: 2 })).toEqual({ accepted: false, reason: 'unsupported_major_version' });
  });
  it.each(['count', 'duplicate', 'undeclared', 'omitted', 'failure', 'duplicate-context', 'family', 'utf8'])('rejects invalid %s', kind => {
    const f = networkContextFixture();
    if (kind === 'count') f.sections[0]!.rowCount++;
    if (kind === 'duplicate') f.sections.push(f.sections[0]!);
    if (kind === 'undeclared') f.sections[0]!.contextKey = 'elsewhere';
    if (kind === 'omitted') f.sections[0]!.omittedRowCount = 1;
    if (kind === 'failure') f.sections[0]!.outcome = 'failed';
    if (kind === 'duplicate-context') f.contextManifest.contexts.push(f.contextManifest.contexts[0]!);
    if (kind === 'family') f.sections[0]!.addressFamily = 'ipv6';
    if (kind === 'utf8') f.producerEpoch = 'é'.repeat(128);
    expect(networkContextV1Schema.safeParse(f).success).toBe(false);
  });
  it('accepts explicitly partial omission and absent sections without inventing completeness', () => {
    const f = networkContextFixture(); f.sections = [f.sections[0]!]; f.sections[0]!.outcome = 'partial'; f.sections[0]!.omittedRowCount = 1; f.sections[0]!.reasonCode = 'limit_exceeded';
    const parsed = networkContextV1Schema.parse(f); expect(parsed.reportKind === 'full' && parsed.sections.length).toBe(1);
  });
  it('enforces aggregate per-context interface limits across family sections', () => {
    const f = networkContextFixture(); const s = f.sections[0]!; if (s.kind !== 'interfaces') throw Error('fixture');
    s.rows = Array.from({ length: 65 }, (_, i) => ({ ...s.rows[0]!, rowKey: `${i}`, interfaceKey: `${i}`, addresses: [] })); s.rowCount = 65;
    f.contextManifest.contexts[0]!.families.push('ipv6'); f.sections.push({ ...s, addressFamily: 'ipv6' });
    expect(networkContextV1Schema.safeParse(f).success).toBe(false);
  });
  it('canonicalizes addresses, prefixes and MACs', () => {
    expect(topologyIpSchema.parse('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(topologyCidrSchema.parse('192.0.2.17/24')).toBe('192.0.2.0/24');
    expect(topologyCidrSchema.parse('2001:db8::1/64')).toBe('2001:db8::/64');
    expect(topologyMacSchema.parse('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
  });
  it('validates family, scoped link local and optional versus null', () => {
    const base = { address: 'fe80::1', zone: 'en0', prefixLength: 64, family: 'ipv6', state: 'preferred', assignment: 'link_local' };
    expect(topologyAddressRowSchema.safeParse(base).success).toBe(true);
    for (const changes of [{ zone: null }, { family: 'ipv4' }, { prefixLength: 129 }, { address: 'fe80::1%en0' }]) expect(topologyAddressRowSchema.safeParse({ ...base, ...changes }).success).toBe(false);
    const f = networkContextFixture(); Object.assign(f.sections[0]!.rows[0]!, { permanentMac: null }); expect(networkContextV1Schema.safeParse(f).success).toBe(false);
  });
  it('requires route family/next-hop agreement and limits unsupported rule coverage', () => {
    const f = networkContextFixture(); const route = f.sections[1]!.rows[0]!;
    expect(topologyRouteRowSchema.safeParse({ ...route, family: 'ipv6' }).success).toBe(false);
    const rule = { rowKey: 'r', priority: 1, tableKey: null, action: 'other', selectors: [], selectorCoverage: 'complete', unsupportedSelectorKinds: ['tos'] };
    expect(topologyRuleRowSchema.safeParse(rule).success).toBe(false);
    expect(topologyRuleRowSchema.safeParse({ ...rule, selectorCoverage: 'partial' }).success).toBe(true);
  });
});
