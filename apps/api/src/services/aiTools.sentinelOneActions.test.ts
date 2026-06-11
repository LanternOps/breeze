import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../services/sentinelOne/actions', () => ({
  executeS1IsolationForOrg: vi.fn(),
  executeS1ThreatActionForOrg: vi.fn(),
  getActiveS1IntegrationForOrg: vi.fn()
}));

import { aiTools } from './aiTools';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg
} from '../services/sentinelOne/actions';

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User', isPlatformAdmin: false },
    token: { mfa: true } as any,
    partnerId: null,
    orgId: 'org-123',
    scope: 'organization',
    accessibleOrgIds: ['org-123'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  };
}

describe('sentinelone ai action tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValue({
      id: 'int-1',
      orgId: 'org-123',
      name: 'SentinelOne',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
  });

  it('returns warning payload for s1_isolate_device when provider has no activity id', async () => {
    vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        requestedDeviceIds: ['device-1'],
        inaccessibleDeviceIds: [],
        unmappedAccessibleDeviceIds: [],
        requestedDevices: 1,
        mappedAgents: 1,
        providerActionId: null,
        actions: [{ id: 'action-1', deviceId: 'device-1' }],
        warning: 'Provider did not return activityId; action cannot be tracked'
      }
    } as any);

    const output = await aiTools.get('s1_isolate_device')!.handler({ deviceId: 'device-1' }, makeAuth());
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.providerActionId).toBeNull();
    expect(parsed.warning).toContain('activityId');
  });

  it('requires MFA for s1_isolate_device', async () => {
    const output = await aiTools.get('s1_isolate_device')!.handler(
      { deviceId: 'device-1' },
      { ...makeAuth(), token: { mfa: false } as any }
    );
    const parsed = JSON.parse(output);

    expect(parsed.error).toBe('MFA required');
    expect(executeS1IsolationForOrg).not.toHaveBeenCalled();
  });

  it('returns failure payload for s1_threat_action when dispatch fails', async () => {
    vi.mocked(executeS1ThreatActionForOrg).mockResolvedValueOnce({
      ok: true,
      status: 502,
      data: {
        action: 'kill',
        requestedThreats: 1,
        matchedThreats: 1,
        matchedThreatIds: ['s1-threat-1'],
        unmatchedThreatIds: [],
        providerActionId: null,
        actions: [{ id: 'action-err-1', deviceId: 'device-1' }],
        warning: 'SentinelOne action dispatch failed: provider timeout'
      }
    } as any);

    const output = await aiTools.get('s1_threat_action')!.handler(
      { action: 'kill', threatIds: ['s1-threat-1'] },
      makeAuth()
    );
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('SentinelOne action dispatch failed');
    expect(parsed.actions).toHaveLength(1);
  });

  it('requires MFA for s1_threat_action', async () => {
    const output = await aiTools.get('s1_threat_action')!.handler(
      { action: 'kill', threatIds: ['s1-threat-1'] },
      { ...makeAuth(), token: { mfa: false } as any }
    );
    const parsed = JSON.parse(output);

    expect(parsed.error).toBe('MFA required');
    expect(executeS1ThreatActionForOrg).not.toHaveBeenCalled();
  });

  it('returns partial threat results from s1_threat_action', async () => {
    vi.mocked(executeS1ThreatActionForOrg).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        action: 'quarantine',
        requestedThreats: 2,
        matchedThreats: 1,
        matchedThreatIds: ['s1-threat-1'],
        unmatchedThreatIds: ['missing-threat'],
        providerActionId: 'activity-1',
        actions: [{ id: 'action-1', deviceId: 'device-1' }]
      }
    } as any);

    const output = await aiTools.get('s1_threat_action')!.handler(
      { action: 'quarantine', threatIds: ['s1-threat-1', 'missing-threat'] },
      makeAuth()
    );
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.unmatchedThreatIds).toEqual(['missing-threat']);
    expect(parsed.matchedThreatIds).toEqual(['s1-threat-1']);
  });
});
