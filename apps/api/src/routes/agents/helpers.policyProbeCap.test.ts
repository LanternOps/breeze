/**
 * #11976: the per-org probe list the heartbeat hands the agent is capped.
 * Compliance rules from every active configuration policy the org can own now
 * feed it, so an org with very many registry/config checks would otherwise
 * send an unbounded list on every config update. The cap keeps the first
 * MAX_POLICY_STATE_PROBES_PER_ORG probes in the list's sorted order (so the
 * kept set is the same on every beat) and logs a warning when it trims.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, queue } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const makeSelectChain = () => {
    const rows = queue.shift() ?? [];
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };
  return { dbMock: { select: vi.fn(() => makeSelectChain()) }, queue };
});

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  hasDbAccessContext: () => false,
  runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
  db: dbMock,
}));

import {
  buildPolicyProbeConfigUpdate,
  derivePolicyStateProbesFromRules,
  MAX_POLICY_STATE_PROBES_PER_ORG,
  sortPolicyRegistryProbes,
} from './helpers';
import { uncollectableComplianceRegistryPaths } from './policyProbeSafety';

const pad = (n: number) => String(n).padStart(4, '0');
const registryRule = (n: number) => ({
  type: 'registry_check', registryPath: `HKLM\\SOFTWARE\\Policies\\Key${pad(n)}`, registryValueName: 'Enabled',
});
const configRule = (n: number) => ({
  type: 'config_check', configFilePath: `/etc/sysctl.d/${pad(n)}.conf`, configKey: 'net.ipv4.ip_forward',
});

/** Reverse order, so a cap that sliced before sorting would keep the wrong half. */
function rulesDescending(count: number, make: (n: number) => unknown) {
  return Array.from({ length: count }, (_, i) => make(count - 1 - i));
}

describe('buildPolicyProbeConfigUpdate per-org cap (#11976)', () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };

  beforeEach(() => {
    queue.length = 0;
    dbMock.select.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as typeof warn;
  });
  afterEach(() => warn.mockRestore());

  it('caps at 256', () => {
    expect(MAX_POLICY_STATE_PROBES_PER_ORG).toBe(256);
  });

  it('keeps the first 256 registry and config probes in sorted order and warns once per list', async () => {
    const total = MAX_POLICY_STATE_PROBES_PER_ORG + 44;
    // automation_policies rows, then configuration-policy compliance rows.
    queue.push(
      [{ rules: rulesDescending(150, registryRule) }],
      [
        { rules: rulesDescending(total, registryRule) },
        { rules: rulesDescending(total, configRule) },
      ],
    );

    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });

    const registry = probe!.policy_registry_state_probes;
    const config = probe!.policy_config_state_probes;
    expect(registry).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
    expect(config).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
    expect(registry[0]!.registry_path).toBe('HKLM\\SOFTWARE\\Policies\\Key0000');
    expect(registry.at(-1)!.registry_path).toBe(`HKLM\\SOFTWARE\\Policies\\Key${pad(MAX_POLICY_STATE_PROBES_PER_ORG - 1)}`);
    expect(config[0]!.file_path).toBe('/etc/sysctl.d/0000.conf');
    expect(config.at(-1)!.file_path).toBe(`/etc/sysctl.d/${pad(MAX_POLICY_STATE_PROBES_PER_ORG - 1)}.conf`);

    const capWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('probe list truncated'));
    expect(capWarnings).toHaveLength(2);
    expect(capWarnings[0]![1] as object).toMatchObject({ orgId: 'org-1', kind: 'registry', total, kept: MAX_POLICY_STATE_PROBES_PER_ORG });
    expect(capWarnings[1]![1] as object).toMatchObject({ orgId: 'org-1', kind: 'config', total, kept: MAX_POLICY_STATE_PROBES_PER_ORG });
  });

  it('keeps the same probes whatever order the rows arrive in', async () => {
    const total = MAX_POLICY_STATE_PROBES_PER_ORG + 10;
    const ascending = Array.from({ length: total }, (_, i) => registryRule(i));
    queue.push([], [{ rules: ascending }]);
    const first = await buildPolicyProbeConfigUpdate('org-1', { partnerId: null });
    queue.push([], [{ rules: [...ascending].reverse() }]);
    const second = await buildPolicyProbeConfigUpdate('org-1', { partnerId: null });
    expect(second!.policy_registry_state_probes).toEqual(first!.policy_registry_state_probes);
  });

  it('does not warn at or under the cap', async () => {
    queue.push([], [{ rules: rulesDescending(MAX_POLICY_STATE_PROBES_PER_ORG, registryRule) }]);
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: null });
    expect(probe!.policy_registry_state_probes).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('probe list truncated'))).toHaveLength(0);
  });
});

/**
 * #11976: the write-time refusal must agree with the probe builder. A path the
 * builder drops must be refused when written, and a path it probes accepted.
 */
describe('uncollectableComplianceRegistryPaths agrees with derivePolicyStateProbesFromRules', () => {
  const PATHS = [
    'HKLM\\SOFTWARE\\Policies\\Example',
    'HKEY_LOCAL_MACHINE/SOFTWARE/Policies/Example',
    'HKLM\\SAM',
    'hklm\\sam\\SAM\\Domains',
    'HKLM\\ SAM',
    'HKLM\\SOFTWARE\\..\\SAM',
    'HKEY_LOCAL_MACHINE/SECURITY/Policy/Secrets',
    '  HKLM\\SECURITY  ',
    'HKLM\\ſam',
    'HKCU\\SAM',
    'HKLM\\SAMPLE\\Key',
  ];

  it.each(PATHS)('%s', (path) => {
    const rules = [{ type: 'registry_check', registryPath: path, registryValueName: 'V' }];
    const probed = derivePolicyStateProbesFromRules(rules).registry.length === 1;
    const refused = uncollectableComplianceRegistryPaths({ items: [{ name: 'x', rules }] }).length === 1;
    expect(refused).toBe(!probed);
  });

  it('reads rules the way the builder does: snake_case path, upper-case type, name fallback, dedupe', () => {
    const items: Array<{ name: string; rules?: unknown[] }> = [
      { name: 'a', rules: [{ type: 'REGISTRY_CHECK', registry_path: 'HKLM\\SAM', registry_value_name: 'F' }] },
      { name: 'b', rules: [{ name: 'registry_check', registryPath: ' HKLM\\SAM ', registryValueName: 'F' }] },
      { name: 'c' },
      { name: 'd', rules: [{ type: 'registry_check', registryPath: '' }, { type: 'config_check', registryPath: 'HKLM\\SAM' }] },
    ];
    expect(uncollectableComplianceRegistryPaths({ items })).toEqual(['HKLM\\SAM']);
    expect(derivePolicyStateProbesFromRules(items.flatMap((i) => i.rules ?? [])).registry).toEqual([]);
  });
});

describe('probe sort tie-break', () => {
  it('orders localeCompare ties by code point, whatever the input order', () => {
    // NFC and NFD spellings of the same text compare equal under localeCompare.
    const nfc = 'HKLM\\SOFTWARE\\Café';
    const nfd = 'HKLM\\SOFTWARE\\Café';
    expect(nfc.localeCompare(nfd)).toBe(0);
    const a = { registry_path: nfc, value_name: 'V' };
    const b = { registry_path: nfd, value_name: 'V' };
    expect(sortPolicyRegistryProbes([a, b])).toEqual(sortPolicyRegistryProbes([b, a]));
  });
});

/**
 * #12130: the org's own policies and its partner's partner-wide policies each
 * keep a reserved share of the cap. Before, the merged list's sorted head was
 * kept, so partner-wide probes that sorted first could push every one of the
 * org's own probes off the list.
 */
describe('buildPolicyProbeConfigUpdate reserves capacity per source (#12130)', () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  const orgKey = (n: number) => ({
    type: 'registry_check', registryPath: `HKLM\\SOFTWARE\\ZZOrg\\Key${pad(n)}`, registryValueName: 'Enabled',
  });
  const partnerKey = (n: number) => ({
    type: 'registry_check', registryPath: `HKLM\\SOFTWARE\\AAPartner\\Key${pad(n)}`, registryValueName: 'Enabled',
  });
  const countOf = (probes: Array<{ registry_path: string }>, marker: string) =>
    probes.filter((p) => p.registry_path.includes(marker)).length;

  beforeEach(() => {
    queue.length = 0;
    dbMock.select.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as typeof warn;
  });
  afterEach(() => warn.mockRestore());

  it('a partner-wide policy that sorts first cannot starve the org\'s own probes', async () => {
    queue.push(
      [],
      [
        { rules: rulesDescending(300, partnerKey), assignedOwnerOrgId: null },
        { rules: rulesDescending(200, orgKey), assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    expect(registry).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
    expect(countOf(registry, 'ZZOrg')).toBe(MAX_POLICY_STATE_PROBES_PER_ORG / 2);
    expect(countOf(registry, 'AAPartner')).toBe(MAX_POLICY_STATE_PROBES_PER_ORG / 2);
    // Each source keeps its own sorted head, and the list is sent sorted.
    expect(registry.some((p) => p.registry_path.endsWith('ZZOrg\\Key0000'))).toBe(true);
    expect(registry).toEqual(sortPolicyRegistryProbes(registry));
  });

  it('an org that needs less than its share leaves the rest to partner-wide probes', async () => {
    queue.push(
      [{ rules: rulesDescending(50, orgKey), ownerOrgId: 'org-1' }],
      [{ rules: rulesDescending(300, partnerKey), assignedOwnerOrgId: null }],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    expect(countOf(registry, 'ZZOrg')).toBe(50);
    expect(countOf(registry, 'AAPartner')).toBe(MAX_POLICY_STATE_PROBES_PER_ORG - 50);
  });

  it('an org with many of its own probes keeps everything partner-wide probes do not use', async () => {
    queue.push(
      [],
      [
        { rules: rulesDescending(40, partnerKey), assignedOwnerOrgId: null },
        { rules: rulesDescending(400, orgKey), assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    expect(countOf(registry, 'AAPartner')).toBe(40);
    expect(countOf(registry, 'ZZOrg')).toBe(MAX_POLICY_STATE_PROBES_PER_ORG - 40);
  });

  it('a probe both sides ask for counts once, as the org\'s own', async () => {
    queue.push(
      [],
      [
        { rules: rulesDescending(300, partnerKey), assignedOwnerOrgId: null },
        { rules: [...rulesDescending(10, orgKey), partnerKey(299)], assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    // partnerKey(299) sorts last among partner probes, so only the org's claim keeps it.
    expect(registry.some((p) => p.registry_path.endsWith('AAPartner\\Key0299'))).toBe(true);
    expect(registry).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
  });

  // Strix (PR #12184): an org policy that re-lists a partner-wide probe must not
  // take the partner's claim when its own copy can be truncated. Here the org has
  // more than its reserve, and its copy sorts after the org's kept head.
  it('an org copy that can be truncated does not remove the partner\'s claim', async () => {
    const earlyOrgKey = (n: number) => ({
      type: 'registry_check', registryPath: `HKLM\\SOFTWARE\\AAAOrg\\Key${pad(n)}`, registryValueName: 'Enabled',
    });
    queue.push(
      [],
      [
        { rules: rulesDescending(100, partnerKey), assignedOwnerOrgId: null },
        { rules: [...rulesDescending(200, earlyOrgKey), partnerKey(0)], assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    // 301 probes: the org keeps 156 (its 200 own sort first, so its copy of
    // partnerKey(0) is cut), the partner keeps all 100 of its own.
    expect(registry).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
    expect(countOf(registry, 'AAPartner')).toBe(100);
    expect(registry.some((p) => p.registry_path.endsWith('AAPartner\\Key0000'))).toBe(true);
  });

  // Review of the Strix fix: a probe both sources list must not take a slot on
  // each side. An org that clones its partner's 140-probe policy needs 140.
  it('probes both sources list count once against the cap', async () => {
    queue.push(
      [],
      [
        { rules: rulesDescending(140, partnerKey), assignedOwnerOrgId: null },
        { rules: rulesDescending(140, partnerKey), assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    expect(probe!.policy_registry_state_probes).toHaveLength(140);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('probe list truncated'))).toHaveLength(0);
  });

  it('an org copy past its guaranteed head rides on the partner\'s claim and frees an org slot', async () => {
    const earlyOrgKey = (n: number) => ({
      type: 'registry_check', registryPath: `HKLM\\SOFTWARE\\AAAOrg\\Key${pad(n)}`, registryValueName: 'Enabled',
    });
    queue.push(
      [],
      [
        { rules: rulesDescending(200, partnerKey), assignedOwnerOrgId: null },
        // 200 own probes plus 50 copies of partner probes that sort after them.
        { rules: [...rulesDescending(200, earlyOrgKey), ...rulesDescending(50, partnerKey)], assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    // Disjoint sets: org 200, partner 200, each guaranteed 128 of the 256.
    expect(registry).toHaveLength(MAX_POLICY_STATE_PROBES_PER_ORG);
    expect(countOf(registry, 'AAAOrg')).toBe(128);
    expect(countOf(registry, 'AAPartner')).toBe(128);
  });

  it('a probe kept by both sources is sent once', async () => {
    queue.push(
      [],
      [
        { rules: rulesDescending(10, partnerKey), assignedOwnerOrgId: null },
        // partnerKey(0) sorts first among the org's 151 probes, so the org keeps it too.
        { rules: [...rulesDescending(150, orgKey), partnerKey(0)], assignedOwnerOrgId: 'org-1' },
      ],
    );
    const probe = await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const registry = probe!.policy_registry_state_probes;
    const keys = registry.map((p) => `${p.registry_path}::${p.value_name}`.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(countOf(registry, 'AAPartner')).toBe(10);
  });

  it('the truncation warning names the per-source counts', async () => {
    queue.push(
      [],
      [
        { rules: rulesDescending(300, partnerKey), assignedOwnerOrgId: null },
        { rules: rulesDescending(200, orgKey), assignedOwnerOrgId: 'org-1' },
      ],
    );
    await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const capWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('probe list truncated'));
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]![1] as object).toMatchObject({
      orgId: 'org-1',
      kind: 'registry',
      total: 500,
      kept: MAX_POLICY_STATE_PROBES_PER_ORG,
      orgOwned: { total: 200, kept: 128 },
      partnerWide: { total: 300, kept: 128 },
    });
    // The dropped rules are named: the org's sorted tail first, then the partner's.
    const sample = (capWarnings[0]![1] as { droppedSample: Array<{ registry_path: string }> }).droppedSample;
    expect(sample).toHaveLength(10);
    expect(sample[0]!.registry_path).toBe('HKLM\\SOFTWARE\\ZZOrg\\Key0128');
  });

  it('a link inherited from a partner-wide parent counts as partner-wide under an org-owned child', async () => {
    queue.push(
      [],
      [
        // Inherited: assigned through the org's child, authored by the partner-wide parent.
        { rules: rulesDescending(300, orgKey), assignedOwnerOrgId: 'org-1', sourceId: 'parent', sourceOwnerOrgId: null },
        { rules: rulesDescending(300, partnerKey), assignedOwnerOrgId: 'org-1', sourceId: 'child', sourceOwnerOrgId: 'org-1' },
      ],
    );
    await buildPolicyProbeConfigUpdate('org-1', { partnerId: 'partner-1' });
    const capWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('probe list truncated'));
    expect(capWarnings[0]![1] as object).toMatchObject({
      orgOwned: { total: 300, kept: 128 },
      partnerWide: { total: 300, kept: 128 },
    });
    const sample = (capWarnings[0]![1] as { droppedSample: Array<{ registry_path: string }> }).droppedSample;
    // The child's own (AAPartner-named) rules are the org-owned tail here.
    expect(sample[0]!.registry_path).toBe('HKLM\\SOFTWARE\\AAPartner\\Key0128');
  });
});
