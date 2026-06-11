import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('../services/serverConfig', () => ({
  getServerUrl: async () => 'http://localhost:3001',
}));

vi.mock('../services/installationId', () => ({
  getOrCreateInstallationId: async () => 'install-test',
}));

import reducer, {
  blockPairedDevice,
  fetchPairedDevices,
  revokeConnectedAppAsync,
  fetchConnectedApps,
  clearLifecycleErrors,
  resetLifecycle,
} from './lifecycleSlice';

const initial = reducer(undefined, { type: '@@INIT' });

describe('lifecycleSlice — reducers', () => {
  it('clearLifecycleErrors clears both error fields', () => {
    const seeded = { ...initial, devicesError: 'x', appsError: 'y' };
    const next = reducer(seeded, clearLifecycleErrors());
    expect(next.devicesError).toBeNull();
    expect(next.appsError).toBeNull();
  });

  it('resetLifecycle drops devices and apps', () => {
    const seeded = {
      ...initial,
      devices: [{
        id: 'd-1',
        deviceId: 'inst-1',
        platform: 'ios' as const,
        model: null,
        osVersion: null,
        appVersion: null,
        lastActiveAt: null,
        status: 'active' as const,
        blockedAt: null,
        blockedReason: null,
        createdAt: new Date().toISOString(),
        isCurrent: false,
      }],
    };
    const next = reducer(seeded, resetLifecycle());
    expect(next.devices).toHaveLength(0);
    expect(next.apps).toHaveLength(0);
  });
});

describe('lifecycleSlice — fetch + block lifecycle', () => {
  it('fetchPairedDevices.fulfilled stores devices and clears loading', () => {
    const action = {
      type: fetchPairedDevices.fulfilled.type,
      payload: [{
        id: 'd-1',
        deviceId: 'inst-1',
        platform: 'ios',
        model: 'iPhone',
        osVersion: '18',
        appVersion: '1.0',
        lastActiveAt: null,
        status: 'active',
        blockedAt: null,
        blockedReason: null,
        createdAt: new Date().toISOString(),
        isCurrent: true,
      }],
    };
    const next = reducer({ ...initial, devicesLoading: true }, action);
    expect(next.devicesLoading).toBe(false);
    expect(next.devices).toHaveLength(1);
    expect(next.devices[0].isCurrent).toBe(true);
  });

  it('blockPairedDevice.fulfilled marks the matching device blocked in place', () => {
    const seeded = {
      ...initial,
      pendingDeviceId: 'd-2',
      devices: [
        {
          id: 'd-1',
          deviceId: 'inst-1',
          platform: 'ios' as const,
          model: null,
          osVersion: null,
          appVersion: null,
          lastActiveAt: null,
          status: 'active' as const,
          blockedAt: null,
          blockedReason: null,
          createdAt: '',
          isCurrent: true,
        },
        {
          id: 'd-2',
          deviceId: 'inst-2',
          platform: 'android' as const,
          model: null,
          osVersion: null,
          appVersion: null,
          lastActiveAt: null,
          status: 'active' as const,
          blockedAt: null,
          blockedReason: null,
          createdAt: '',
          isCurrent: false,
        },
      ],
    };

    const action = { type: blockPairedDevice.fulfilled.type, payload: 'd-2' };
    const next = reducer(seeded, action);
    expect(next.pendingDeviceId).toBeNull();
    expect(next.devices[0].status).toBe('active');
    expect(next.devices[1].status).toBe('blocked');
    expect(next.devices[1].blockedAt).not.toBeNull();
  });

  it('blockPairedDevice.rejected surfaces the message and clears pending', () => {
    const seeded = { ...initial, pendingDeviceId: 'd-1' };
    const action = { type: blockPairedDevice.rejected.type, payload: 'boom' };
    const next = reducer(seeded, action);
    expect(next.pendingDeviceId).toBeNull();
    expect(next.devicesError).toBe('boom');
  });
});

describe('lifecycleSlice — connected apps', () => {
  it('fetchConnectedApps.fulfilled stores apps', () => {
    const action = {
      type: fetchConnectedApps.fulfilled.type,
      payload: [
        {
          clientId: 'claude',
          displayName: 'Claude Desktop',
          createdAt: '',
          lastUsedAt: null,
          lastApprovalDecidedAt: null,
          revokedAt: null,
        },
      ],
    };
    const next = reducer(initial, action);
    expect(next.apps).toHaveLength(1);
  });

  it('revokeConnectedAppAsync.fulfilled stamps revokedAt on the matching client', () => {
    const seeded = {
      ...initial,
      pendingAppId: 'claude',
      apps: [
        {
          clientId: 'claude',
          displayName: 'Claude Desktop',
          createdAt: '',
          lastUsedAt: null,
          lastApprovalDecidedAt: null,
          revokedAt: null,
        },
      ],
    };
    const action = { type: revokeConnectedAppAsync.fulfilled.type, payload: 'claude' };
    const next = reducer(seeded, action);
    expect(next.apps[0].revokedAt).not.toBeNull();
    expect(next.pendingAppId).toBeNull();
  });
});
