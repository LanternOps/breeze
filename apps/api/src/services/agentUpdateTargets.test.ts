import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => {
  const limit = vi.fn();
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy, limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    select,
    from,
    where,
    orderBy,
    limit,
  };
});

vi.mock('../db', () => ({
  db: {
    select: dbMocks.select,
  },
}));

import { resolveComponentUpdateDecision, resolveManualComponentTarget } from './agentUpdateTargets';
import { normalizeAgentUpdateSettings } from '../routes/agents/agentUpdatePolicy';

describe('resolveComponentUpdateDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.limit.mockResolvedValue([{ version: '0.70.0' }]);
  });

  it('offers a manual reinstall target when an agent reports a non-release version string', async () => {
    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: 'integration-smoke-agent',
        watchdogVersion: '0.69.0',
      },
      component: 'agent',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'automatic',
        agentUpdateTiming: 'asap',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: 'integration-smoke-agent',
      targetVersion: '0.70.0',
      mode: 'automatic',
      autoInstall: false,
      pinned: false,
      reason: 'non-release-version',
    });
  });

  it('does not auto-replace dev agent builds, but still exposes a manual reinstall target', async () => {
    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: 'dev-integration-test',
        watchdogVersion: '0.69.0',
      },
      component: 'agent',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'automatic',
        agentUpdateTiming: 'asap',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: 'dev-integration-test',
      targetVersion: '0.70.0',
      autoInstall: false,
      reason: 'non-release-version',
    });
  });

  it('offers a manual reinstall target when a watchdog reports a non-release version string', async () => {
    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: '0.83.0',
        watchdogVersion: 'agent-watchdog-update-bbce5c5dab306bf0df72989a134441f104173945',
      },
      component: 'watchdog',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'automatic',
        agentUpdateTiming: 'asap',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: 'agent-watchdog-update-bbce5c5dab306bf0df72989a134441f104173945',
      targetVersion: '0.70.0',
      mode: 'automatic',
      autoInstall: false,
      pinned: false,
      reason: 'non-release-version',
    });
  });

  it('flags old release agents for the legacy heartbeat upgrade path', async () => {
    dbMocks.limit.mockResolvedValueOnce([{ version: '0.82.2' }]);

    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: '0.82.1',
        watchdogVersion: '0.82.1',
      },
      component: 'agent',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'manual',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: '0.82.1',
      targetVersion: '0.82.2',
      mode: 'manual',
      autoInstall: false,
      pinned: false,
      action: 'legacy-agent-update',
      reason: 'legacy-agent',
    });
  });

  it('treats 0.82.2 as component-update capable', async () => {
    dbMocks.limit.mockResolvedValueOnce([{ version: '0.82.3' }]);

    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: '0.82.2',
        watchdogVersion: '0.82.2',
      },
      component: 'agent',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'manual',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: '0.82.2',
      targetVersion: '0.82.3',
      mode: 'manual',
      autoInstall: false,
      pinned: false,
      action: 'component-update',
      reason: 'manual',
    });
  });

  it('blocks watchdog repair/update while the main agent is too old to execute it', async () => {
    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: '0.82.1',
        watchdogVersion: null,
      },
      component: 'watchdog',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'manual',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: null,
      targetVersion: '0.70.0',
      mode: 'manual',
      autoInstall: false,
      pinned: false,
      missing: true,
      blockedBy: 'legacy-agent',
      reason: 'legacy-agent',
    });
  });

  it('blocks main-agent component updates while the watchdog cannot poll healthy commands', async () => {
    dbMocks.limit.mockResolvedValueOnce([{ version: '0.84.0' }]);

    const decision = await resolveComponentUpdateDecision({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: '0.83.0',
        watchdogVersion: '0.82.1',
      },
      component: 'agent',
      settings: normalizeAgentUpdateSettings({
        agentUpdateMode: 'manual',
      }),
    });

    expect(decision).toMatchObject({
      available: true,
      currentVersion: '0.83.0',
      targetVersion: '0.84.0',
      autoInstall: false,
      blockedBy: 'legacy-watchdog',
      reason: 'legacy-watchdog',
    });
  });

  it('rejects normal manual component updates for legacy agents', async () => {
    dbMocks.limit
      .mockResolvedValueOnce([{ settings: { defaults: { agentUpdateMode: 'manual' } } }])
      .mockResolvedValueOnce([{ version: '0.83.0' }]);

    const result = await resolveManualComponentTarget({
      device: {
        id: 'device-1',
        orgId: 'org-1',
        osType: 'linux',
        architecture: 'amd64',
        agentVersion: '0.82.1',
        watchdogVersion: '0.82.1',
      },
      component: 'agent',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: 'LEGACY_AGENT_UPDATE_REQUIRED',
    });
  });
});
