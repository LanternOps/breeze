import { describe, expect, it } from 'vitest';

import {
  AgentVersionRow,
  BROKEN_AGENT_VERSIONS,
  DeviceRow,
  planRecovery,
} from './recover-stuck-agents.lib';

function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'dev-1',
    hostname: 'host-1',
    agentVersion: '0.65.5',
    osType: 'linux',
    architecture: 'amd64',
    status: 'online',
    ...overrides,
  };
}

function makeBinary(overrides: Partial<AgentVersionRow> = {}): AgentVersionRow {
  return {
    // Use a version outside BROKEN_AGENT_VERSIONS as the default target — the
    // recovery safety check refuses to dispatch a broken target back at the
    // fleet (the load-bearing assertion below).
    version: '0.65.10',
    platform: 'linux',
    architecture: 'amd64',
    downloadUrl: 'https://example/agent-linux-amd64',
    checksum: 'sha256:deadbeef',
    ...overrides,
  };
}

describe('planRecovery', () => {
  it('queues a healthy device with a registered non-broken binary', () => {
    const { plans, skipped } = planRecovery([makeDevice()], [makeBinary()]);
    expect(skipped).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0].device.id).toBe('dev-1');
    expect(plans[0].binary.version).toBe('0.65.10');
  });

  it('refuses to dispatch when the latest registered binary is itself a broken version (the safety check that prevented an outage)', () => {
    // This is the load-bearing safety net: if the operator forgot to bump
    // BREEZE_VERSION, agent_versions still has 0.65.6 as isLatest, and
    // re-pushing 0.65.6 would just recreate the failed-update loop.
    const broken = makeBinary({ version: '0.65.6' });
    const { plans, skipped } = planRecovery([makeDevice()], [broken]);
    expect(plans).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('still 0.65.6 (broken)');
    expect(skipped[0].reason).toContain('Bump BREEZE_VERSION');
  });

  it('skips devices with null os_type with a distinct reason', () => {
    const { plans, skipped } = planRecovery(
      [makeDevice({ id: 'dev-no-os', osType: null })],
      [makeBinary()],
    );
    expect(plans).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('os_type is null');
  });

  it('skips devices with unrecognised architecture without crashing', () => {
    const { plans, skipped } = planRecovery(
      [makeDevice({ id: 'dev-mips', architecture: 'mips' })],
      [makeBinary()],
    );
    expect(plans).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('unrecognised architecture');
    expect(skipped[0].reason).toContain('mips');
  });

  it('matches platform/arch exactly — windows device with only linux binary registered is skipped, not coerced', () => {
    const winDev = makeDevice({ id: 'dev-win', osType: 'windows', architecture: 'amd64' });
    const linuxDev = makeDevice({ id: 'dev-lin', osType: 'linux', architecture: 'amd64' });
    const { plans, skipped } = planRecovery(
      [winDev, linuxDev],
      [makeBinary({ platform: 'linux', architecture: 'amd64' })],
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].device.id).toBe('dev-lin');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].device.id).toBe('dev-win');
    expect(skipped[0].reason).toContain('no isLatest=true agent binary registered for windows/amd64');
  });

  it('normalises common architecture aliases (x86_64 → amd64, aarch64 → arm64)', () => {
    const x86Dev = makeDevice({ id: 'dev-x86', osType: 'linux', architecture: 'x86_64' });
    const aarchDev = makeDevice({ id: 'dev-aarch', osType: 'linux', architecture: 'aarch64' });
    const { plans } = planRecovery(
      [x86Dev, aarchDev],
      [
        makeBinary({ platform: 'linux', architecture: 'amd64' }),
        makeBinary({ platform: 'linux', architecture: 'arm64' }),
      ],
    );
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.device.id === 'dev-x86')?.binary.architecture).toBe('amd64');
    expect(plans.find((p) => p.device.id === 'dev-aarch')?.binary.architecture).toBe('arm64');
  });

  it('treats BROKEN_AGENT_VERSIONS as exact-match — a hypothetical 0.65.5-rc.1 binary would NOT be flagged broken', () => {
    // Documents the exact-match assumption (project releases use bare semver).
    // If we ever ship a pre-release through the same agent_versions table,
    // either change BROKEN_AGENT_VERSIONS to a prefix check or pin those
    // pre-releases to non-isLatest.
    const rc = makeBinary({ version: '0.65.5-rc.1' });
    const { plans, skipped } = planRecovery([makeDevice()], [rc]);
    expect(plans).toHaveLength(1);
    expect(plans[0].binary.version).toBe('0.65.5-rc.1');
    expect(skipped).toEqual([]);
  });

  it('exports BROKEN_AGENT_VERSIONS as a non-empty const so callers and tests share one source of truth', () => {
    expect(BROKEN_AGENT_VERSIONS.length).toBeGreaterThan(0);
    expect(BROKEN_AGENT_VERSIONS).toContain('0.65.5');
    expect(BROKEN_AGENT_VERSIONS).toContain('0.65.6');
  });

  it('flags all known stuck-version agents (#612 + #625 + #646)', () => {
    // 0.65.5 / 0.65.6: wrong embedded manifest trust root (#568, PR #612).
    // 0.65.7 / 0.65.8: predate per-deployment manifest pinning (#625);
    //   on BINARY_SOURCE=local these agents reject locally-signed manifests.
    // 0.65.9: enforces manifest.URL == info.URL strictly (#646);
    //   on BINARY_SOURCE=github the server now hands out a server-relative
    //   download URL that doesn't match the github.com URL signed into the
    //   manifest, so 0.65.9 agents reject.
    expect(BROKEN_AGENT_VERSIONS).toEqual(
      expect.arrayContaining(['0.65.5', '0.65.6', '0.65.7', '0.65.8', '0.65.9']),
    );
  });
});
