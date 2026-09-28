import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ currentOrgId: null, organizations: [{ id: 'org-1', name: 'Acme Corp' }] });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});
vi.mock('../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});

import PatchesPage from './PatchesPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('PatchesPage Run Scan is permission-gated (#7215)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.granted.clear();
    window.history.replaceState({}, '', '/#patches');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return json({ data: [] });
      if (url === '/patches?limit=200') return json({ data: [] });
      if (url === '/patches/compliance') {
        return json({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [] } });
      }
      if (url === '/devices?limit=200') return json({ devices: [] });
      return json({}, false, 404);
    });
  });

  it('hides Run Scan without devices:execute while the page still renders', async () => {
    render(<PatchesPage />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('patch-run-scan')).toBeNull();
  });

  it('shows Run Scan with devices:execute', async () => {
    h.granted.add('devices:execute');
    render(<PatchesPage />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByTestId('patch-run-scan')).toBeInTheDocument();
  });
});
