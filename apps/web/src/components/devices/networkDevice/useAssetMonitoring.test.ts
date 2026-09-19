import '@/lib/i18n';

import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetMonitoring } from './useAssetMonitoring';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const ASSET_ID = 'asset-1';

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const assetPayload = {
  enabled: true,
  snmpDevice: {
    id: 'snmp-1', templateId: 'tpl-1', pollingInterval: 300, port: 161,
    snmpVersion: 'v2c', isActive: true, lastPolled: '2026-09-16T10:00:00.000Z', lastStatus: 'online',
  },
  collection: {
    templateId: 'tpl-1', lastPolledAt: '2026-09-16T10:00:00.000Z', pollingInterval: 300,
    status: 'ok', consecutiveFailures: 0,
    oids: [{ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast', state: 'collecting', observedAt: '2026-09-16T10:00:00.000Z', instances: [], error: null }],
  },
  networkMonitors: { totalCount: 1, activeCount: 1 },
  recentMetrics: [],
};

const monitorsPayload = {
  data: [{
    id: 'mon-1', orgId: 'org-1', assetId: ASSET_ID, name: 'Ping', monitorType: 'icmp_ping',
    target: '10.0.0.9', config: {}, pollingInterval: 60, timeout: 5, isActive: true,
    lastChecked: '2026-09-16T10:01:00.000Z', lastStatus: 'online', lastResponseMs: 4.2,
    lastError: null, consecutiveFailures: 0,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-16T10:01:00.000Z',
  }],
  total: 1,
};

const thresholdsPayload = {
  data: [{ id: 'th-1', oid: '1.3.6.1.2.1.43.11.1.1.9.1.1', operator: 'lt', threshold: '10', severity: 'high', message: 'Toner low', isActive: true }],
};

const templatesPayload = {
  data: [{ id: 'tpl-1', name: 'Generic Printer (RFC 3805)', source: 'builtin', oidCount: 18 }],
};

/** Answers each of the four parallel calls by URL, in any order. */
function routeFetch(overrides: Partial<Record<'asset' | 'monitors' | 'thresholds' | 'templates', Response>> = {}) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.includes('/thresholds')) return Promise.resolve(overrides.thresholds ?? json(thresholdsPayload));
    if (url.startsWith('/monitors')) return Promise.resolve(overrides.monitors ?? json(monitorsPayload));
    if (url.startsWith('/snmp/templates')) return Promise.resolve(overrides.templates ?? json(templatesPayload));
    return Promise.resolve(overrides.asset ?? json(assetPayload));
  });
}

describe('useAssetMonitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads collection, checks, thresholds and the template name', async () => {
    routeFetch();
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collection?.oids).toHaveLength(1);
    expect(result.current.snmpDevice?.pollingInterval).toBe(300);
    expect(result.current.templateName).toBe('Generic Printer (RFC 3805)');
    expect(result.current.checks[0].name).toBe('Ping');
    expect(result.current.thresholds[0].severity).toBe('high');
    expect(result.current.error).toBeNull();
    expect(result.current.checksError).toBe(false);
    expect(result.current.thresholdsError).toBe(false);
    expect(result.current.templateError).toBe(false);

    const urls = fetchWithAuthMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain(`/monitoring/assets/${ASSET_ID}`);
    expect(urls).toContain(`/monitoring/assets/${ASSET_ID}/thresholds`);
    expect(urls).toContain(`/monitors?assetId=${ASSET_ID}`);
    expect(urls.some((u) => u.startsWith('/snmp/templates'))).toBe(true);
  });

  it('keeps the tab usable when only the thresholds call fails', async () => {
    routeFetch({ thresholds: json({ error: 'boom' }, 500) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collection?.oids).toHaveLength(1);
    expect(result.current.checks).toHaveLength(1);
    expect(result.current.thresholds).toEqual([]);
    expect(result.current.thresholdsError).toBe(true);
    // A degraded panel is not a failed tab.
    expect(result.current.error).toBeNull();
  });

  it.each(['monitors', 'thresholds', 'templates'] as const)('exposes %s failures and clears them after retry', async (panel) => {
    routeFetch({ [panel]: json({ error: 'boom' }, 500) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const flag = { monitors: 'checksError', thresholds: 'thresholdsError', templates: 'templateError' }[panel] as 'checksError' | 'thresholdsError' | 'templateError';
    expect(result.current[flag]).toBe(true);
    expect(result.current.error).toBeNull();
    routeFetch();
    await act(async () => { await result.current.reload(); });
    expect(result.current[flag]).toBe(false);
  });

  it.each(['monitors', 'thresholds', 'templates'] as const)('exposes unreadable JSON from %s and clears the failure after retry', async (panel) => {
    const unreadable = json(null);
    vi.mocked(unreadable.json).mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
    routeFetch({ [panel]: unreadable });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const flag = { monitors: 'checksError', thresholds: 'thresholdsError', templates: 'templateError' }[panel] as 'checksError' | 'thresholdsError' | 'templateError';
    expect(result.current[flag]).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.collection?.oids).toHaveLength(1);
    routeFetch();
    await act(async () => { await result.current.reload(); });
    expect(result.current[flag]).toBe(false);
  });

  it('reports an error only when the asset call itself fails', async () => {
    routeFetch({ asset: json({ error: 'nope' }, 500) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();
    expect(result.current.collection).toBeNull();
  });

  it('leaves collection null (not a fabricated empty) on a pre-W01 API', async () => {
    routeFetch({ asset: json({ enabled: false, snmpDevice: null, networkMonitors: { totalCount: 0, activeCount: 0 }, recentMetrics: [] }) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collection).toBeNull();
    expect(result.current.snmpDevice).toBeNull();
    expect(result.current.templateName).toBeNull();
  });

  it('refetches all four on reload', async () => {
    routeFetch();
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = fetchWithAuthMock.mock.calls.length;

    await act(async () => { await result.current.reload(); });

    expect(fetchWithAuthMock.mock.calls.length).toBe(before + 4);
  });
});
