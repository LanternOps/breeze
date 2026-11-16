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

import { buildPolicyProbeConfigUpdate, MAX_POLICY_STATE_PROBES_PER_ORG } from './helpers';

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
