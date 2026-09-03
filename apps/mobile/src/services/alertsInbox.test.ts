import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('tok'),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.test') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('inst-1') }));

const fetchWithTimeout = vi.fn();
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a),
}));

import { getAlerts } from './api';

function jsonOnce(body: unknown) {
  fetchWithTimeout.mockImplementationOnce(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  );
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe('getAlerts inbox query', () => {
  it('requests active alerts by default', async () => {
    // The inbox is ordered by recency with no severity weighting. Asking for
    // everything lets resolved low-severity rows consume the page, which is how
    // a fleet with thousands of alerts rendered zero issues.
    jsonOnce({ data: [] });
    await getAlerts();
    const url = String(fetchWithTimeout.mock.calls[0][0]);
    expect(url).toContain('/alerts/inbox');
    expect(url).toContain('status=active');
  });

  it('can still request the unfiltered inbox explicitly', async () => {
    jsonOnce({ data: [] });
    await getAlerts('all');
    const url = String(fetchWithTimeout.mock.calls[0][0]);
    expect(url).toContain('/alerts/inbox');
    expect(url).not.toContain('status=');
  });

  it('maps returned rows and preserves orgId for client-side org filtering', async () => {
    jsonOnce({
      data: [
        { id: 'a1', title: 't', message: 'm', severity: 'high', status: 'active',
          orgId: 'org-1', triggeredAt: '2026-08-18T00:00:00Z' },
      ],
    });
    const alerts = await getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].acknowledged).toBe(false);
    // The Systems org filter matches on metadata.orgId — losing it silently
    // empties the filtered view.
    expect((alerts[0].metadata as Record<string, unknown>).orgId).toBe('org-1');
  });

  it('surfaces the rule template category from the inbox row (#4535)', async () => {
    jsonOnce({
      data: [
        { id: 'a1', title: 't', message: 'm', severity: 'high', status: 'active',
          orgId: 'org-1', triggeredAt: '2026-08-18T00:00:00Z', category: 'Security' },
      ],
    });
    const alerts = await getAlerts();
    expect(alerts[0].category).toBe('Security');
  });

  it('leaves category undefined for alerts with no rule (nullable join)', async () => {
    jsonOnce({
      data: [
        { id: 'a2', title: 't', message: 'm', severity: 'low', status: 'active',
          orgId: 'org-1', triggeredAt: '2026-08-18T00:00:00Z', category: null },
      ],
    });
    const alerts = await getAlerts();
    expect(alerts[0].category).toBeUndefined();
  });
});
