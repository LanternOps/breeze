import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HuntressIntegration from './HuntressIntegration';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => 'https://us.2breeze.app')
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
  partnerId: 'partner-1',
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

const breezeOrg = {
  id: '00000000-0000-4000-8000-000000000001',
  partnerId: 'partner-1',
  name: 'Acme Corp',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z'
};

const discoveredHuntressOrg = {
  huntressOrgId: 'huntress-org-1',
  huntressOrgName: 'Acme Huntress',
  huntressOrgKey: 'acme',
  huntressAccountId: 'acct-123',
  agentsCount: 2,
  incidentsCount: 1,
  mappedOrgId: null,
  mappedOrgName: null,
  lastSeenAt: null
};

function mockPartnerLoad(options: {
  integration?: typeof existingIntegration | null;
  mappings?: unknown[];
  statusOk?: boolean;
} = {}) {
  const integration = options.integration === undefined ? null : options.integration;
  const mappings = options.mappings ?? [];
  fetchWithAuthMock.mockImplementation(async (url, init) => {
    if (url === '/huntress/integration' && init?.method === 'POST') {
      return makeResponse({ id: 'huntress-1' }, true, integration ? 200 : 201);
    }
    if (url === '/huntress/organizations/map' && init?.method === 'POST') {
      return makeResponse({ data: { ...discoveredHuntressOrg, mappedOrgId: breezeOrg.id, mappedOrgName: breezeOrg.name } });
    }
    if (url === '/huntress/integration') return makeResponse({ data: integration });
    if (url === '/huntress/status') {
      return options.statusOk === false
        ? makeResponse({ error: 'upstream error' }, false, 502)
        : makeResponse(emptyStatus);
    }
    if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
    if (url === '/huntress/organizations') return makeResponse({ data: mappings });
    if (url === '/orgs/organizations') return makeResponse({ data: [breezeOrg] });
    return makeResponse({}, false, 404);
  });
}

describe('HuntressIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      currentOrgId: '00000000-0000-4000-8000-000000000001'
    });
  });

  it('loads the partner connection and mapping table in all-orgs scope', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration, mappings: [discoveredHuntressOrg] });

    render(<HuntressIntegration />);

    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());
    expect(screen.getByText('Organization mapping')).toBeInTheDocument();
    expect(screen.getByText('Acme Huntress')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/integration');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/status');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/incidents?limit=5');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/organizations');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/organizations');
  });

  it('loads Huntress resources when scoped to a current organization', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === '/huntress/integration') return makeResponse({ data: existingIntegration, mapped: true });
      if (url === '/huntress/status') return makeResponse({ ...emptyStatus, mapped: true });
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() => expect(screen.getByText('Sync status')).toBeInTheDocument());
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/integration');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/status');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/huntress/incidents?limit=5');
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/huntress/organizations');
  });

  it('collects Huntress API Key and API Secret separately and submits them as one credential pair', async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad();

    render(<HuntressIntegration />);

    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());
    expect(screen.getByText(/Breeze formats the Basic auth credential automatically/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Partner Huntress'), 'Production Huntress');
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
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad();

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('Partner Huntress'), 'Production Huntress');
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
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

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
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === '/huntress/integration' && init?.method === 'POST') {
        return makeResponse({ error: 'Invalid Huntress credentials' }, false, 400);
      }
      if (url === '/huntress/integration') return makeResponse({ data: null });
      if (url === '/huntress/status') return makeResponse(emptyStatus);
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      if (url === '/huntress/organizations') return makeResponse({ data: [] });
      if (url === '/orgs/organizations') return makeResponse({ data: [breezeOrg] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('Partner Huntress'), 'Production Huntress');
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

  it('maps a discovered Huntress organization to a Breeze organization', async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration, mappings: [discoveredHuntressOrg] });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Organization mapping')).toBeInTheDocument());

    await user.selectOptions(screen.getByDisplayValue('Select organization'), breezeOrg.id);

    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some(
          ([url, init]) => url === '/huntress/organizations/map' && init?.method === 'POST'
        )
      ).toBe(true);
    });

    const mapCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/huntress/organizations/map' && init?.method === 'POST'
    );
    expect(JSON.parse(String(mapCall?.[1]?.body))).toMatchObject({
      integrationId: 'huntress-1',
      huntressOrgId: 'huntress-org-1',
      orgId: breezeOrg.id
    });
  });

  it('surfaces a region-correct, copyable inbound webhook URL carrying the integrationId', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText('Inbound webhook (push from Huntress)')).toBeInTheDocument()
    );
    expect(
      screen.getByText('https://us.2breeze.app/api/v1/huntress/webhook?integrationId=huntress-1')
    ).toBeInTheDocument();
    // Signing scheme is documented so the user can configure the Huntress side.
    expect(screen.getByText(/Signing scheme to configure on Huntress/)).toBeInTheDocument();
  });

  it('warns that inbound webhooks are rejected until a webhook secret is configured', async () => {
    useOrgStore.setState({ currentOrgId: null });
    // existingIntegration.hasWebhookSecret is false.
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText('Inbound webhook (push from Huntress)')).toBeInTheDocument()
    );
    expect(screen.getByText(/inbound webhooks are rejected with 403/i)).toBeInTheDocument();
  });

  it('does not surface the partner webhook URL or Generate button in organization scope', async () => {
    // currentOrgId is set (org scope) by the default beforeEach. The webhook
    // endpoint + secret are partner-level and must not leak into a customer-org
    // context (guarded by isPartnerView).
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === '/huntress/integration') return makeResponse({ data: existingIntegration, mapped: true });
      if (url === '/huntress/status') return makeResponse({ ...emptyStatus, mapped: true });
      if (url === '/huntress/incidents?limit=5') return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() => expect(screen.getByText('Sync status')).toBeInTheDocument());
    expect(screen.queryByText('Inbound webhook (push from Huntress)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/huntress\/webhook\?integrationId=/)).not.toBeInTheDocument();
  });

  it('generates a webhook secret, fills the input, and shows a copy-once notice that is submitted on save', async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Generate/i }));

    // Copy-once notice appears; the secret input is revealed (type=text) and populated.
    expect(screen.getByText(/Copy this webhook secret now/i)).toBeInTheDocument();
    const secretInput = screen.getByPlaceholderText('Enter or generate a webhook secret') as HTMLInputElement;
    expect(secretInput.value).toMatch(/^[0-9a-f]{64}$/);
    const generated = secretInput.value;

    await user.click(screen.getByRole('button', { name: /Update/i }));

    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some(([url, init]) => url === '/huntress/integration' && init?.method === 'POST')
      ).toBe(true);
    });
    const postCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/huntress/integration' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ webhookSecret: generated });
  });

  it('clears the copy-once notice when the user manually edits the generated secret', async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Generate/i }));
    expect(screen.getByText(/Copy this webhook secret now/i)).toBeInTheDocument();

    // Typing into the secret field means the user is supplying their own value;
    // the "you just generated this, copy it now" banner no longer applies.
    await user.type(screen.getByPlaceholderText('Enter or generate a webhook secret'), 'x');
    expect(screen.queryByText(/Copy this webhook secret now/i)).not.toBeInTheDocument();
  });
});
