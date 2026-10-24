import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PsaConnectionsPage from './PsaConnectionsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => 'https://example.test'),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: {} }),
}));
vi.mock('@/lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'organization', partnerId: null }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) => selector({ organizations: [], currentOrgId: null }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const CONNECTION = { id: 'c1', provider: 'jira', name: 'Primary', status: 'active' };
const DETAILS = {
  ...CONNECTION,
  settings: {},
  credentials: { baseUrl: 'https://acme.atlassian.net', username: 'admin@acme.com' },
  hasCredentials: true,
  credentialFields: { apiToken: true },
};

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

let requests: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    if (url.startsWith('/psa/tickets')) return jsonResponse({ data: [] });
    if (method === 'GET' && url === '/psa/connections') return jsonResponse({ data: [CONNECTION] });
    if (method === 'GET' && url === '/psa/connections/c1') return jsonResponse({ data: DETAILS });
    if (method === 'POST' && url === '/psa/connections/c1/test') {
      return jsonResponse({ success: true, message: 'Credentials OK' });
    }
    if (method === 'DELETE' && url === '/psa/connections/c1') return jsonResponse({ success: true });
    throw new Error(`Unexpected fetchWithAuth call: ${method} ${url}`);
  });
});

describe('PsaConnectionsPage heading level', () => {
  it('standalone renders the page title as the h1', async () => {
    render(<PsaConnectionsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'PSA Integrations' })).toBeInTheDocument();
  });

  it('embedded renders the title as an h2 and no h1 (the Integrations page owns the h1)', async () => {
    render(<PsaConnectionsPage embedded />);
    expect(await screen.findByRole('heading', { level: 2, name: 'PSA Integrations' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('button', { name: /add connection/i })).toBeInTheDocument();
  });
});

describe('PsaConnectionsPage modals are real dialogs (Escape closes)', () => {
  async function expectDialogClosesOnEscape(name: string) {
    const dialog = await screen.findByRole('dialog', { name });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it('add', async () => {
    const user = userEvent.setup();
    render(<PsaConnectionsPage />);
    await user.click(await screen.findByRole('button', { name: /add connection/i }));
    await expectDialogClosesOnEscape('Add PSA Connection');
  });

  it('edit', async () => {
    const user = userEvent.setup();
    render(<PsaConnectionsPage />);
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    await expectDialogClosesOnEscape('Edit PSA Connection');
  });

  it('delete', async () => {
    const user = userEvent.setup();
    render(<PsaConnectionsPage />);
    await user.click(await screen.findByTestId('psa-connection-delete'));
    const dialog = await screen.findByRole('dialog', { name: 'Delete PSA Connection' });
    // Active connections keep their active warning in the confirm.
    expect(dialog).toHaveTextContent('Deleting it removes the connection immediately.');
    await expectDialogClosesOnEscape('Delete PSA Connection');
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
  });

  it('delete confirm still DELETEs and closes', async () => {
    const user = userEvent.setup();
    render(<PsaConnectionsPage />);
    await user.click(await screen.findByTestId('psa-connection-delete'));
    await screen.findByRole('dialog', { name: 'Delete PSA Connection' });
    await user.click(screen.getByRole('button', { name: 'Delete connection' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests).toContainEqual({ url: '/psa/connections/c1', method: 'DELETE' });
  });

  it('test result', async () => {
    const user = userEvent.setup();
    render(<PsaConnectionsPage />);
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    await user.click(await screen.findByTestId('psa-test-connection'));
    const dialog = await screen.findByRole('dialog', { name: 'Connection Test Result' });
    expect(dialog).toHaveTextContent('Credentials OK');
    await expectDialogClosesOnEscape('Connection Test Result');
  });
});
