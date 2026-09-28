import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
}));

import AlertDetailPage from './AlertDetailPage';
import { useOrgStore } from '@/stores/orgStore';

const alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

async function renderPage() {
  fetchWithAuth.mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.endsWith('/tickets') ? { data: [] } : alert),
    })
  );
  render(<AlertDetailPage alertId={alert.id} />);
  await screen.findByRole('heading', { name: alert.title });
}

beforeEach(() => {
  h.granted.clear();
  fetchWithAuth.mockReset();
  useOrgStore.setState({ serviceManagementMode: 'native' });
});

const btn = (re: RegExp) => screen.queryByRole('button', { name: re });

describe('AlertDetailPage actions are permission-gated (#7215)', () => {
  it('hides Acknowledge, Resolve and Create ticket without permissions', async () => {
    await renderPage();
    expect(btn(/^acknowledge/i)).toBeNull();
    expect(btn(/^resolve/i)).toBeNull();
    expect(screen.queryByTestId('alert-create-ticket')).toBeNull();
  });

  it('alerts:acknowledge grants only Acknowledge', async () => {
    h.granted.add('alerts:acknowledge');
    await renderPage();
    expect(btn(/^acknowledge/i)).not.toBeNull();
    expect(btn(/^resolve/i)).toBeNull();
    expect(screen.queryByTestId('alert-create-ticket')).toBeNull();
  });

  it('alerts:write grants only Resolve', async () => {
    h.granted.add('alerts:write');
    await renderPage();
    expect(btn(/^acknowledge/i)).toBeNull();
    expect(btn(/^resolve/i)).not.toBeNull();
    expect(screen.queryByTestId('alert-create-ticket')).toBeNull();
  });

  it('tickets:write grants Create ticket (native mode)', async () => {
    h.granted.add('tickets:write');
    await renderPage();
    expect(screen.queryByTestId('alert-create-ticket')).not.toBeNull();
    expect(btn(/^resolve/i)).toBeNull();
  });
});
