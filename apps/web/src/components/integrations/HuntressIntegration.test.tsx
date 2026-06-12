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
});
