import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HuntressIntegration from './HuntressIntegration';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload)
  } as unknown as Response;
}

const existingIntegration = {
  id: 'huntress-1',
  orgId: '00000000-0000-4000-8000-000000000001',
  name: 'Existing Huntress',
  accountId: 'acct-123',
  apiBaseUrl: 'https://api.huntress.io',
  isActive: true,
  lastSyncAt: null,
  lastSyncStatus: 'success',
  lastSyncError: null,
  hasWebhookSecret: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

const emptyStatus = {
  coverage: { totalAgents: 0, mappedAgents: 0, unmappedAgents: 0, offlineAgents: 0 },
  incidents: { open: 0, bySeverity: [], byStatus: [] }
};

describe('HuntressIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      currentOrgId: '00000000-0000-4000-8000-000000000001',
      orgScope: 'current'
    });
  });

  it('shows single-organization guidance and does not call Huntress APIs in all-orgs scope', async () => {
    useOrgStore.setState({ orgScope: 'all' });

    render(<HuntressIntegration />);

    expect(screen.getByText('Huntress Integration')).toBeInTheDocument();
    expect(screen.getByText(/The Huntress integration is configured per organization/)).toBeInTheDocument();
    expect(screen.getByText('All orgs')).toBeInTheDocument();

    await Promise.resolve();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('loads Huntress resources when scoped to a current organization', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === '/huntress/integration') return makeResponse({ data: null });
      if (url === '/huntress/status') {
        return makeResponse({
          coverage: { totalAgents: 0, mappedAgents: 0, unmappedAgents: 0, offlineAgents: 0 },
          incidents: { open: 0, bySeverity: [], byStatus: [] }
        });
      }
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() => expect(screen.getByText('Connection')).toBeInTheDocument());
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/integration');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/status');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/incidents?limit=5');
  });

  it('collects Huntress API Key and API Secret separately and submits them as one credential pair', async () => {
    const user = userEvent.setup();
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === '/huntress/integration' && init?.method === 'POST') {
        return makeResponse({ id: 'huntress-1' }, true, 201);
      }
      if (url === '/huntress/integration') return makeResponse({ data: null });
      if (url === '/huntress/status') {
        return makeResponse({
          coverage: { totalAgents: 0, mappedAgents: 0, unmappedAgents: 0, offlineAgents: 0 },
          incidents: { open: 0, bySeverity: [], byStatus: [] }
        });
      }
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() => expect(screen.getByText('Connection')).toBeInTheDocument());
    expect(screen.getByText(/Do not paste the Base 64 encoded version of Key and Secret/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('My Huntress Integration'), 'Production Huntress');
    await user.type(screen.getByPlaceholderText('hk_...'), 'hk_14b7a762d4770fe29e47');
    await user.type(screen.getByPlaceholderText('hs_...'), 'hs_9d3e49c689f781a453d028374ff665ab');
    await user.click(screen.getByRole('button', { name: /Save & Connect/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock.mock.calls.some(([url, init]) => url === '/huntress/integration' && init?.method === 'POST')).toBe(true);
    });

    const postCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/huntress/integration' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: 'Production Huntress',
      apiKey: 'hk_14b7a762d4770fe29e47:hs_9d3e49c689f781a453d028374ff665ab',
      isActive: true
    });
  });

  it('blocks a half-credential (key without secret): shows an error, disables Save, and never POSTs', async () => {
    const user = userEvent.setup();
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === '/huntress/integration') return makeResponse({ data: null });
      if (url === '/huntress/status') return makeResponse(emptyStatus);
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Connection')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('My Huntress Integration'), 'Production Huntress');
    await user.type(screen.getByPlaceholderText('hk_...'), 'hk_only_the_key');

    expect(screen.getByText(/Enter both the API Key and API Secret from Huntress/)).toBeInTheDocument();

    const saveButton = screen.getByRole('button', { name: /Save & Connect/i });
    expect(saveButton).toBeDisabled();

    await user.click(saveButton);
    expect(
      fetchWithAuthMock.mock.calls.some(([url, init]) => url === '/huntress/integration' && init?.method === 'POST')
    ).toBe(false);
  });

  it('updates an existing integration without re-entering credentials and omits apiKey from the POST', async () => {
    const user = userEvent.setup();
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === '/huntress/integration' && init?.method === 'POST') {
        return makeResponse({ id: 'huntress-1' }, true, 200);
      }
      if (url === '/huntress/integration') return makeResponse({ data: existingIntegration });
      if (url === '/huntress/status') return makeResponse(emptyStatus);
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Connection')).toBeInTheDocument());

    // Name is prefilled from the existing integration; Update is enabled with no credential input.
    const updateButton = screen.getByRole('button', { name: /Update/i });
    expect(updateButton).toBeEnabled();
    await user.click(updateButton);

    await waitFor(() => {
      expect(fetchWithAuthMock.mock.calls.some(([url, init]) => url === '/huntress/integration' && init?.method === 'POST')).toBe(true);
    });

    const postCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/huntress/integration' && init?.method === 'POST'
    );
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body).not.toHaveProperty('apiKey');
    expect(body).toMatchObject({ name: 'Existing Huntress', isActive: true });
  });

  it('surfaces a save failure to the user', async () => {
    const user = userEvent.setup();
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === '/huntress/integration' && init?.method === 'POST') {
        return makeResponse({ error: 'Invalid Huntress credentials' }, false, 400);
      }
      if (url === '/huntress/integration') return makeResponse({ data: null });
      if (url === '/huntress/status') return makeResponse(emptyStatus);
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Connection')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('My Huntress Integration'), 'Production Huntress');
    await user.type(screen.getByPlaceholderText('hk_...'), 'hk_14b7a762d4770fe29e47');
    await user.type(screen.getByPlaceholderText('hs_...'), 'hs_9d3e49c689f781a453d028374ff665ab');
    await user.click(screen.getByRole('button', { name: /Save & Connect/i }));

    await waitFor(() => expect(screen.getByText('Invalid Huntress credentials')).toBeInTheDocument());
  });

  it('warns when live status fails to load instead of rendering an all-clear', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === '/huntress/integration') return makeResponse({ data: existingIntegration });
      if (url === '/huntress/status') return makeResponse({ error: 'upstream error' }, false, 502);
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText(/Live Huntress status could not be fully loaded/)).toBeInTheDocument()
    );
  });
});
