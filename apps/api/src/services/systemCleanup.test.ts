import { describe, expect, it } from 'vitest';
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  agentSupportsSystemCleanup,
  isUnknownCommandTypeError,
  parseAgentJson,
  systemCleanupAgentGate,
  systemCleanupCatalogSchema,
  systemCleanupRunResultSchema,
} from './systemCleanup';

describe('agentSupportsSystemCleanup (spec §5.3)', () => {
  // Plan amendment 11: the newest tag on this branch is v0.114.0, so W04 ships
  // in 0.115.0. Bump this in the same PR if a release lands first.
  it('pins the minimum version W04 ships in', () => {
    expect(MIN_AGENT_VERSION_SYSTEM_CLEANUP).toBe('0.115.0');
    expect(AGENT_UPDATE_REQUIRED_ERROR).toBe('agent_update_required');
  });

  it('accepts the minimum and anything above it', () => {
    for (const version of ['0.115.0', '0.115.1', '0.116.0', '1.0.0', 'v0.115.0']) {
      expect(agentSupportsSystemCleanup(version)).toBe(true);
    }
  });

  it('rejects anything below it', () => {
    for (const version of ['0.114.0', '0.113.9', '0.99.0', '0.114.99']) {
      expect(agentSupportsSystemCleanup(version)).toBe(false);
    }
  });

  // Plan amendment 10: compareAgentVersions returns 0 for an unparseable
  // input, so a naive `>= 0` comparison would let '' through as "equal to the
  // minimum". devices.agent_version is NOT NULL, so '' is reachable.
  it('fails CLOSED on a missing or unparseable version', () => {
    for (const version of ['', '   ', 'dev', 'latest', 'v', null, undefined]) {
      expect(agentSupportsSystemCleanup(version)).toBe(false);
    }
  });

  // "core semver" (spec §5.3): a prerelease of the shipping version is the
  // lab build W05 runs the acceptance gate on. Gating it out would make the
  // gate untestable.
  it('compares the core only, so an rc of the shipping version passes', () => {
    expect(agentSupportsSystemCleanup('0.115.0-rc1')).toBe(true);
    expect(agentSupportsSystemCleanup('0.114.0-rc1')).toBe(false);
  });
});

describe('isUnknownCommandTypeError', () => {
  // The agent's fallback for a type it has no handler for
  // (heartbeat.go:6475). It is the defensive half of the 409: a device that
  // reports a version above the minimum but genuinely lacks the handler
  // (a hand-built binary, a botched update) still gets "update the agent"
  // instead of a bare failure with no next step.
  it('matches the agent fallback and nothing else', () => {
    expect(isUnknownCommandTypeError('unknown command type: system_cleanup_list')).toBe(true);
    expect(isUnknownCommandTypeError('  unknown command type: system_cleanup_run')).toBe(true);
    expect(isUnknownCommandTypeError('cleanmgr.exe not present')).toBe(false);
    expect(isUnknownCommandTypeError('the agent said unknown command type: later on')).toBe(false);
    expect(isUnknownCommandTypeError(null)).toBe(false);
    expect(isUnknownCommandTypeError(undefined)).toBe(false);
  });
});

const catalogFixture = {
  catalogVersion: 1,
  actions: [
    {
      id: 'linux_pkg_cache_clean',
      label: 'Package manager cache',
      description: 'Removes downloaded package archives.',
      os: 'linux',
      available: true,
      estimateBytes: 412_000_000,
      estimateKnown: true,
      estimateDetail: 'size of /var/cache/apt/archives',
      riskFlags: [],
      affectsVolumes: ['/'],
    },
    {
      id: 'linux_pkg_autoremove',
      label: 'Remove orphaned packages',
      description: 'Removes dependency-only packages.',
      os: 'linux',
      available: false,
      unavailableReason: 'sandbox denies write to /var/cache/apt',
      estimateKnown: false,
      riskFlags: ['removes_packages'],
      affectsVolumes: ['/'],
    },
  ],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

describe('systemCleanupCatalogSchema', () => {
  it('accepts the agent §7.3 shape', () => {
    const parsed = systemCleanupCatalogSchema.parse(catalogFixture);
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[1]?.unavailableReason).toBe('sandbox denies write to /var/cache/apt');
  });

  it('accepts cleanmgr sub-actions', () => {
    const parsed = systemCleanupCatalogSchema.parse({
      ...catalogFixture,
      actions: [{
        id: 'win_cleanmgr',
        label: 'Windows Disk Cleanup',
        description: 'Runs the built-in handlers you select.',
        os: 'windows',
        available: true,
        estimateKnown: false,
        riskFlags: ['long_running'],
        affectsVolumes: [],
        subActions: [
          { id: 'win_cleanmgr:update_cleanup', label: 'Windows Update cleanup', estimateKnown: false },
          { id: 'win_cleanmgr:temporary_files', label: 'Temporary files', estimateBytes: 1_024, estimateKnown: true },
        ],
      }],
    });
    expect(parsed.actions[0]?.subActions).toHaveLength(2);
  });

  // The server never trusts an agent-supplied id: a compromised or buggy agent
  // must not be able to put an arbitrary string into a row the UI then sends
  // straight back in a run request.
  it('rejects an action id outside the shared catalogue', () => {
    const hostile = {
      ...catalogFixture,
      actions: [{ ...catalogFixture.actions[0], id: 'win_cleanmgr:DownloadsFolder' }],
    };
    expect(systemCleanupCatalogSchema.safeParse(hostile).success).toBe(false);
  });

  it('rejects a risk flag outside the shared list', () => {
    const hostile = {
      ...catalogFixture,
      actions: [{ ...catalogFixture.actions[0], riskFlags: ['<img src=x onerror=1>'] }],
    };
    expect(systemCleanupCatalogSchema.safeParse(hostile).success).toBe(false);
  });
});

describe('systemCleanupRunResultSchema', () => {
  it('accepts the agent §7.3 run shape', () => {
    const parsed = systemCleanupRunResultSchema.parse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [
        { id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0, durationMs: 812, outputTail: 'Done' },
        { id: 'linux_journal_vacuum', status: 'failed', exitCode: 1, durationMs: 90, error: 'permission denied' },
      ],
      volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
      freedBytes: 3_000,
    });
    expect(parsed.freedBytes).toBe(3_000);
    expect(parsed.actions[1]?.status).toBe('failed');
  });

  it('rejects an unknown per-action status', () => {
    expect(systemCleanupRunResultSchema.safeParse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [{ id: 'linux_pkg_cache_clean', status: 'sort-of', exitCode: 0, durationMs: 1 }],
      volumes: [],
      freedBytes: 0,
    }).success).toBe(false);
  });

  it('rejects a negative freedBytes — measurement is floored at 0 agent-side', () => {
    expect(systemCleanupRunResultSchema.safeParse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [],
      volumes: [],
      freedBytes: -1,
    }).success).toBe(false);
  });
});

describe('parseAgentJson', () => {
  it('returns the parsed value for valid stdout', () => {
    expect(parseAgentJson(systemCleanupCatalogSchema, JSON.stringify(catalogFixture))?.catalogVersion).toBe(1);
  });

  // The W01 lesson from the AI lane (spec defect 5): an unparseable agent
  // payload must produce NOTHING, never an empty-but-valid record.
  it('returns null for empty, non-JSON or schema-invalid stdout', () => {
    for (const stdout of ['', '   ', 'not json', '{}', '[]', null, undefined]) {
      expect(parseAgentJson(systemCleanupCatalogSchema, stdout)).toBeNull();
    }
  });
});

describe('systemCleanupAgentGate', () => {
  it('allows supported agents', () => {
    expect(systemCleanupAgentGate({ agentVersion: '0.115.0-rc1' })).toEqual({ ok: true });
  });

  it('returns the shared 409 response for old or unparseable agents', () => {
    for (const agentVersion of ['0.114.0', '', 'dev', null]) {
      expect(systemCleanupAgentGate({ agentVersion })).toEqual({
        ok: false,
        status: 409,
        error: 'agent_update_required',
        minAgentVersion: '0.115.0',
      });
    }
  });
});

describe('systemCleanupRunResultSchema maintenance and budget outcomes', () => {
  it.each(['busy', 'not_started'])('accepts the agent %s status for actions and sub-actions', (status) => {
    const parsed = systemCleanupRunResultSchema.parse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [{
        id: 'win_cleanmgr',
        status,
        exitCode: -1,
        durationMs: 0,
        subActions: [{ id: 'win_cleanmgr:update_cleanup', status }],
      }],
      volumes: [],
      freedBytes: 0,
    });
    expect(parsed.actions[0]?.status).toBe(status);
    expect(parsed.actions[0]?.subActions?.[0]?.status).toBe(status);
  });
});
