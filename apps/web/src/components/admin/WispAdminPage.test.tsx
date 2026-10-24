import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import WispAdminPage from './WispAdminPage';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const overview = {
  partners: [
    {
      partnerId: P1, partnerName: 'Acme MSP', plan: 'pro', activeGrants: 3,
      pausedGrants: { budget_exhausted: 2, grantor_suspended: 1 },
      assessmentsToday: 7, specialistRequestsToday: 4, openConcerns: 5, budgetExhaustedGrantsToday: 2,
    },
    {
      partnerId: P2, partnerName: 'Globex IT', plan: 'starter', activeGrants: 0,
      pausedGrants: {}, assessmentsToday: 0, specialistRequestsToday: 0, openConcerns: 0, budgetExhaustedGrantsToday: 0,
    },
  ],
};

const grants = {
  grants: [
    {
      id: 'g1', orgId: null, grantorUserId: 'aaaaaaaa-0000-4000-8000-000000000000', grantorName: 'Ada Lovelace',
      status: 'active', pausedReason: null, expiresAt: '2027-01-01T00:00:00.000Z',
      budgetCentsPerDay: 500, floorTickMinutes: 15, currentRevisionId: 'r1', assessmentsToday: 3,
    },
    {
      id: 'g2', orgId: 'org-uuid-1234', grantorUserId: 'bbbbbbbb-0000-4000-8000-000000000000', grantorName: null,
      status: 'paused', pausedReason: 'budget_exhausted', expiresAt: '2027-02-01T00:00:00.000Z',
      budgetCentsPerDay: 100, floorTickMinutes: 30, currentRevisionId: 'r2', assessmentsToday: 1,
    },
  ],
};

beforeEach(() => fetchWithAuth.mockReset());

describe('WispAdminPage', () => {
  it('renders one row per partner and expands a partner to list its grants', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/admin/wisp/overview') return Promise.resolve(jsonRes(overview));
      if (url === `/admin/wisp/grants?partnerId=${P1}`) return Promise.resolve(jsonRes(grants));
      return Promise.resolve(jsonRes({ error: `unexpected ${String(url)}` }, 500));
    });
    render(<WispAdminPage />);
    const row = await screen.findByTestId(`wisp-admin-partner-row-${P1}`);
    expect(screen.getByTestId(`wisp-admin-partner-row-${P2}`)).toBeTruthy();
    expect(row.textContent).toContain('Acme MSP');
    expect(row.textContent).toContain('3');
    expect(screen.queryByTestId(`wisp-admin-grants-${P1}`)).toBeNull();

    fireEvent.click(row);
    const panel = await screen.findByTestId(`wisp-admin-grants-${P1}`);
    await waitFor(() => expect(panel.textContent).toContain('Ada Lovelace'));
    expect(panel.textContent).toContain('Partner-wide');
    expect(panel.textContent).toContain('bbbbbbbb');
    expect(panel.textContent).toContain('org-uuid-1234');
    expect(fetchWithAuth).toHaveBeenCalledWith(`/admin/wisp/grants?partnerId=${P1}`);
  });

  it('toggles a partner from its keyboard-reachable button and collapses on a second press', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/admin/wisp/overview') return Promise.resolve(jsonRes(overview));
      if (url === `/admin/wisp/grants?partnerId=${P1}`) return Promise.resolve(jsonRes(grants));
      return Promise.resolve(jsonRes({ error: `unexpected ${String(url)}` }, 500));
    });
    render(<WispAdminPage />);
    const toggle = await screen.findByTestId(`wisp-admin-partner-toggle-${P1}`);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    await screen.findByTestId(`wisp-admin-grants-${P1}`);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(screen.queryByTestId(`wisp-admin-grants-${P1}`)).toBeNull();
    // Collapsing and the one expand fetched grants exactly once.
    expect(fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/admin/wisp/grants'))).toHaveLength(1);
  });

  it('shows the platform-admin lock state on 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'platform admin access required' }, 403));
    render(<WispAdminPage />);
    await screen.findByTestId('wisp-admin-locked');
  });

  it('shows the disabled notice on 404', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'not found' }, 404));
    render(<WispAdminPage />);
    const notice = await screen.findByTestId('wisp-admin-disabled');
    expect(notice.textContent).toContain('BREEZE_WISP_ENABLED');
  });

  it('shows an error with retry', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500));
    fetchWithAuth.mockResolvedValueOnce(jsonRes(overview));
    render(<WispAdminPage />);
    await screen.findByTestId('wisp-admin-error');
    fireEvent.click(screen.getByTestId('wisp-admin-retry'));
    await screen.findByTestId(`wisp-admin-partner-row-${P1}`);
  });

  it('shows the empty state', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ partners: [] }));
    render(<WispAdminPage />);
    const el = await screen.findByTestId('wisp-admin-empty');
    expect(el.textContent).toContain('No partners have Wisp grants yet');
  });
});
