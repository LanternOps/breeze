import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));

import PatchesPage from './PatchesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ currentOrgId: null, organizations: [] });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});
vi.mock('../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('PatchesPage patch details drawer (#9544)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/#patches');
    vi.mocked(fetchWithAuth).mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') {
        return json({
          data: [
            { id: 'ring-1', name: 'Pilot', enabled: true, ringOrder: 0, deferralDays: 0, gracePeriodHours: 0,
              autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 } },
            { id: 'ring-2', name: 'Broad', enabled: true, ringOrder: 1, deferralDays: 0, gracePeriodHours: 0,
              autoApprove: { enabled: false, severities: [], deferralDays: 0 } },
          ],
        });
      }
      if (url === '/patches?limit=200') {
        return json({
          data: [
            { id: 'patch-1', title: 'Critical Security Update', severity: 'critical', severitySource: 'derived',
              source: 'microsoft', os: 'windows', packageId: 'KB5001234',
              releaseDate: '2026-04-01T00:00:00.000Z', createdAt: '2026-04-03T00:00:00.000Z',
              approvalStatus: 'pending' },
          ],
        });
      }
      return json({});
    });
  });

  it('Details opens a read-only drawer with the patch facts and per-ring auto-approve date', async () => {
    render(<PatchesPage />);
    const btn = await waitFor(() => desktop().getByTestId('patch-row-patch-1-details'));
    fireEvent.click(btn);
    const drawer = await screen.findByTestId('patch-details-drawer');
    expect(within(drawer).getByText('Critical Security Update')).toBeTruthy();
    expect(within(drawer).getByText('KB5001234')).toBeTruthy();
    expect(within(drawer).getByTestId('patch-details-severity-derived')).toBeTruthy();
    expect(within(drawer).getByTestId('patch-details-release')).toBeTruthy();
    expect(within(drawer).getByTestId('patch-details-first-seen')).toBeTruthy();
    const ring = within(drawer).getByTestId('patch-details-ring-ring-1');
    expect(ring.textContent).toContain('Pilot');
    expect(ring.textContent).toContain('7');
    expect(ring.textContent).toContain(new Date('2026-04-08T00:00:00.000Z').toLocaleDateString());
    // Broad ring has auto-approve disabled → no auto-approve date.
    expect(within(drawer).getByTestId('patch-details-ring-ring-2').textContent).not.toMatch(/Auto-approves/);
    expect(window.location.hash).toBe('#patches/patch-1');
  });

  it('opens from a deep link hash', async () => {
    window.history.replaceState({}, '', '/#patches/patch-1');
    render(<PatchesPage />);
    expect(await screen.findByTestId('patch-details-drawer')).toBeTruthy();
  });
});
