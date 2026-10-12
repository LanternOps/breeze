import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsersPage from './UsersPage';
import { fetchWithAuth } from '../../stores/auth';

// #6111 — the Users page points at the Security tab, where the idle timeout lives.
const storeState: { currentOrgId: string | null; organizations: unknown[] } = {
  currentOrgId: null,
  organizations: [],
};

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) => sel({ user: { id: 'me' } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('UsersPage — session timeout pointer (#6111)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockImplementation(async () => jsonResponse({ data: [] }));
  });

  it('links to the partner Security tab when no org is selected', async () => {
    storeState.currentOrgId = null;
    render(<UsersPage />);
    const link = await screen.findByRole('link', { name: /security/i });
    expect(link.getAttribute('href')).toBe('/settings/partner#security');
    expect(screen.getByTestId('users-session-timeout-pointer').textContent).toMatch(/session idle timeout/i);
  });

  it('links to that org\'s Security tab when an org is selected', async () => {
    storeState.currentOrgId = 'org-1';
    render(<UsersPage />);
    const link = await screen.findByRole('link', { name: /security/i });
    expect(link.getAttribute('href')).toBe('/settings/organizations/org-1#security');
  });
});
