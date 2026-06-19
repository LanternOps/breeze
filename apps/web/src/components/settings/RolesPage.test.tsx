import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RolesPage from './RolesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('RolesPage — access control on the roles list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the access-denied state (not the retryable error) on a 403', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/roles') return json({ error: 'forbidden' }, false, 403);
      return json({}, false, 404);
    });
    render(<RolesPage />);

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to manage roles.")).toBeInTheDocument();
    // A 403 must NOT offer a misleading "Try again" retry.
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  });

  it('renders the retryable error (with Try again) on a non-403 load failure', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/roles') return json({}, false, 500);
      return json({}, false, 404);
    });
    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText('Try again')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });

  it('renders the roles list on a successful load', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/roles') {
        return json({ data: [{ id: 'r1', name: 'Partner Admin', description: null, scope: 'partner', isSystem: true, userCount: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }] });
      }
      if (input === '/permissions/catalog') return json({ permissions: [], resourceLabels: {}, actionLabels: {} });
      return json({}, false, 404);
    });
    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText('Partner Admin')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });
});
