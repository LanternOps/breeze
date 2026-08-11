import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PsaConnectionsPage from './PsaConnectionsPage';
import { fetchWithAuth } from '../../stores/auth';

// `useAuthStore` is a zustand selector hook; the page reads only
// `user.canManagePartnerWide` from it (epic #2135 ownerScope gate).
const authUser: { canManagePartnerWide?: boolean } = {};
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => 'https://us.2breeze.app'),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: authUser }),
}));

// Default: org scope, so the ownerScope selector stays hidden and every
// pre-existing assertion in this file describes an org-owned connection.
const jwtClaims: { scope?: string; partnerId?: string | null } = { scope: 'organization', partnerId: null };
vi.mock('@/lib/authScope', () => ({
  getJwtClaims: () => jwtClaims,
}));

// The page reads its create-time ownerScope default from the shared hook
// (review finding 4) rather than hard-coding 'partner'.
const ownerScopeState: { isPartnerScope: boolean; defaultOwnerScope: 'organization' | 'partner' } = {
  isPartnerScope: false,
  defaultOwnerScope: 'organization',
};
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ownerScopeState,
}));

// Org picker source for the "This organization only" branch (finding 6).
const orgStoreState: { organizations: Array<{ id: string; name: string }>; currentOrgId: string | null } = {
  organizations: [],
  currentOrgId: null,
};
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) => selector(orgStoreState),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

type RecordedRequest = { url: string; method: string; body: unknown };

/**
 * Routes fetchWithAuth calls by URL+method and records mutation payloads so
 * the tests can assert the exact wire shape (the nested credentials/settings
 * contract with serializeConnection in apps/api/src/routes/psa.ts).
 */
function installFetchRouter(routes: Record<string, unknown>, recorded: RecordedRequest[]) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') {
      recorded.push({ url, method, body });
    }
    const key = `${method} ${url}`;
    if (key in routes) {
      return makeResponse(routes[key]);
    }
    if (url.startsWith('/psa/tickets')) {
      return makeResponse({ data: [] });
    }
    throw new Error(`Unexpected fetchWithAuth call: ${key}`);
  });
}

describe('PsaConnectionsPage round-trip contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create POSTs nested {provider, name, credentials, settings} and omits empty credential fields', async () => {
    const recorded: RecordedRequest[] = [];
    installFetchRouter(
      {
        'GET /psa/connections': { data: [] },
        'POST /psa/connections': { id: 'c-new', provider: 'jira', name: 'Jira Prod', status: 'active' },
      },
      recorded
    );

    const user = userEvent.setup();
    render(<PsaConnectionsPage />);

    await user.click(await screen.findByRole('button', { name: /add connection/i }));

    await user.type(screen.getByLabelText(/connection name/i), 'Jira Prod');
    await user.type(screen.getByLabelText(/instance url/i), 'https://acme.atlassian.net');
    await user.type(screen.getByLabelText(/username or email/i), 'admin@acme.com');
    await user.type(screen.getByLabelText(/api token/i), 'tok-123');

    await user.click(screen.getByRole('button', { name: /create connection/i }));

    await waitFor(() => expect(recorded).toHaveLength(1));
    const request = recorded[0]!;
    expect(request.url).toBe('/psa/connections');
    expect(request.method).toBe('POST');
    expect(request.body).toEqual({
      provider: 'jira',
      name: 'Jira Prod',
      credentials: {
        baseUrl: 'https://acme.atlassian.net',
        username: 'admin@acme.com',
        apiToken: 'tok-123',
      },
      settings: {
        syncEnabled: true,
        syncInterval: '1h',
        syncDirection: 'bidirectional',
        syncOnClose: true,
        includeNotes: true,
      },
    });
    // Flat form fields must NOT leak to the top level, and empty secrets must
    // not appear as empty-string credential keys.
    const body = request.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('baseUrl');
    expect(body).not.toHaveProperty('password');
    expect(body.credentials).not.toHaveProperty('password');
    expect(body.credentials).not.toHaveProperty('clientSecret');
  });

  it('edit prefills from nested settings/credentials and PATCHes without untouched secrets', async () => {
    const recorded: RecordedRequest[] = [];
    installFetchRouter(
      {
        'GET /psa/connections': {
          data: [{ id: 'c1', provider: 'jira', name: 'Primary', status: 'active' }],
        },
        'GET /psa/connections/c1': {
          data: {
            id: 'c1',
            provider: 'jira',
            name: 'Primary',
            status: 'active',
            settings: {
              defaultQueue: 'OPS',
              syncEnabled: false,
              syncInterval: '6h',
              syncDirection: 'outbound',
              syncOnClose: false,
              includeNotes: false,
            },
            credentials: {
              baseUrl: 'https://acme.atlassian.net',
              username: 'admin@acme.com',
            },
            hasCredentials: true,
            credentialFields: { password: false, apiToken: true, clientSecret: false },
          },
        },
        'PATCH /psa/connections/c1': { id: 'c1', provider: 'jira', name: 'Renamed', status: 'active' },
      },
      recorded
    );

    const user = userEvent.setup();
    render(<PsaConnectionsPage />);

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));

    // Prefill comes from the nested server response, not flat fields.
    const nameInput = await screen.findByLabelText(/connection name/i);
    await waitFor(() => expect(nameInput).toHaveValue('Primary'));
    expect(screen.getByLabelText(/instance url/i)).toHaveValue('https://acme.atlassian.net');
    expect(screen.getByLabelText(/username or email/i)).toHaveValue('admin@acme.com');
    expect(screen.getByLabelText(/default project or queue/i)).toHaveValue('OPS');
    // Set-but-hidden secret: empty value, masked placeholder.
    const apiTokenInput = screen.getByLabelText(/api token/i);
    expect(apiTokenInput).toHaveValue('');
    expect(apiTokenInput).toHaveAttribute('placeholder', '********');

    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(recorded).toHaveLength(1));
    const request = recorded[0]!;
    expect(request.url).toBe('/psa/connections/c1');
    expect(request.method).toBe('PATCH');
    expect(request.body).toEqual({
      name: 'Renamed',
      credentials: {
        baseUrl: 'https://acme.atlassian.net',
        username: 'admin@acme.com',
      },
      settings: {
        defaultQueue: 'OPS',
        syncEnabled: false,
        syncInterval: '6h',
        syncDirection: 'outbound',
        syncOnClose: false,
        includeNotes: false,
      },
    });
    // PATCH must not send provider, and untouched secrets must be omitted so
    // the server-side merge keeps the stored values.
    const body = request.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('provider');
    expect(body.credentials).not.toHaveProperty('apiToken');
    expect(body.credentials).not.toHaveProperty('password');
    expect(body.credentials).not.toHaveProperty('clientSecret');
  });

  it('renders the ConnectWise-specific credential fields and nests them in the payload', async () => {
    // The form used to offer one generic credential set for every provider, so
    // a ConnectWise connection could not supply companyId/publicKey/privateKey
    // at all and every Test came back 400.
    const recorded: RecordedRequest[] = [];
    installFetchRouter(
      {
        'GET /psa/connections': { data: [] },
        'POST /psa/connections': { id: 'c-cw', provider: 'connectwise', name: 'CW', status: 'active' },
      },
      recorded
    );

    const user = userEvent.setup();
    render(<PsaConnectionsPage />);

    await user.click(await screen.findByRole('button', { name: /add connection/i }));
    await user.selectOptions(screen.getByLabelText(/provider/i), 'connectwise');

    // Jira-only fields are gone; ConnectWise's real keys are present.
    expect(screen.queryByTestId('psa-credential-personalAccessToken')).toBeNull();
    await user.type(screen.getByLabelText(/connection name/i), 'CW');
    await user.type(screen.getByLabelText(/instance url/i), 'https://api-na.myconnectwise.net');
    await user.type(screen.getByTestId('psa-credential-companyId'), 'acme');
    await user.type(screen.getByTestId('psa-credential-publicKey'), 'pub-1');
    await user.type(screen.getByTestId('psa-credential-privateKey'), 'priv-1');

    await user.click(screen.getByRole('button', { name: /create connection/i }));

    await waitFor(() => expect(recorded).toHaveLength(1));
    const body = recorded[0]!.body as { provider: string; credentials: Record<string, string> };
    expect(body.provider).toBe('connectwise');
    expect(body.credentials).toEqual({
      baseUrl: 'https://api-na.myconnectwise.net',
      companyId: 'acme',
      publicKey: 'pub-1',
      privateKey: 'priv-1',
    });
  });

  it('disables Test while credential edits are unsaved', async () => {
    // Test posts to the server, which tests the STORED credentials — a green
    // result would otherwise vouch for credentials about to be overwritten.
    installFetchRouter(
      {
        'GET /psa/connections': {
          data: [{ id: 'c1', provider: 'jira', name: 'Primary', status: 'active' }],
        },
        'GET /psa/connections/c1': {
          data: {
            id: 'c1',
            provider: 'jira',
            name: 'Primary',
            status: 'active',
            settings: {},
            credentials: { baseUrl: 'https://acme.atlassian.net', username: 'admin@acme.com' },
            hasCredentials: true,
            credentialFields: { apiToken: true },
          },
        },
      },
      []
    );

    const user = userEvent.setup();
    render(<PsaConnectionsPage />);

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));

    const testButton = await screen.findByTestId('psa-test-connection');
    expect(testButton).toBeEnabled();
    expect(screen.queryByTestId('psa-test-dirty-hint')).toBeNull();

    await user.type(screen.getByTestId('psa-credential-apiToken'), 'rotated-token');

    await waitFor(() => expect(testButton).toBeDisabled());
    expect(screen.getByTestId('psa-test-dirty-hint')).toBeInTheDocument();
  });

  // ---- Dual ownership: org XOR partner (epic #2135) ----

  describe('ownerScope selector and All orgs badge', () => {
    afterEach(() => {
      // Restore the org-scope default the rest of the file assumes.
      jwtClaims.scope = 'organization';
      jwtClaims.partnerId = null;
      delete authUser.canManagePartnerWide;
      ownerScopeState.isPartnerScope = false;
      ownerScopeState.defaultOwnerScope = 'organization';
      orgStoreState.organizations = [];
      orgStoreState.currentOrgId = null;
    });

    function asPartnerAdmin() {
      jwtClaims.scope = 'partner';
      jwtClaims.partnerId = 'p-1';
      authUser.canManagePartnerWide = true;
      ownerScopeState.isPartnerScope = true;
      ownerScopeState.defaultOwnerScope = 'partner';
    }

    it('renders the "All orgs" badge only for a partner-owned connection', async () => {
      installFetchRouter(
        {
          'GET /psa/connections': {
            data: [
              { id: 'c1', provider: 'jira', name: 'MSP Jira', status: 'active', ownerScope: 'partner' },
              { id: 'c2', provider: 'zendesk', name: 'Customer Zendesk', status: 'active', ownerScope: 'organization' },
            ],
          },
        },
        []
      );

      render(<PsaConnectionsPage />);

      await screen.findByText('MSP Jira');
      expect(screen.getAllByTestId('partner-wide-badge')).toHaveLength(1);
    });

    it('hides the ownerScope selector for an org-scope user', async () => {
      installFetchRouter({ 'GET /psa/connections': { data: [] } }, []);

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      expect(screen.queryByTestId('psa-connection-owner')).toBeNull();
    });

    it('shows the selector defaulted to partner-wide and POSTs ownerScope:partner', async () => {
      asPartnerAdmin();
      const recorded: RecordedRequest[] = [];
      installFetchRouter(
        {
          'GET /psa/connections': { data: [] },
          'POST /psa/connections': { id: 'c-new', provider: 'jira', name: 'MSP Jira', status: 'active', ownerScope: 'partner' },
        },
        recorded
      );

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      expect(screen.getByTestId('psa-connection-owner')).toBeInTheDocument();
      // Partner-wide is the default for a new connection.
      expect(screen.getByTestId('psa-connection-owner-partner')).toBeChecked();
      expect(screen.getByTestId('psa-connection-owner-org')).not.toBeChecked();

      await user.type(screen.getByLabelText(/connection name/i), 'MSP Jira');
      await user.type(screen.getByLabelText(/instance url/i), 'https://acme.atlassian.net');
      await user.type(screen.getByLabelText(/username or email/i), 'admin@acme.com');
      await user.type(screen.getByLabelText(/api token/i), 'tok-123');
      await user.click(screen.getByRole('button', { name: /create connection/i }));

      await waitFor(() => expect(recorded).toHaveLength(1));
      expect((recorded[0]!.body as Record<string, unknown>).ownerScope).toBe('partner');
    });

    it('POSTs ownerScope:organization when the org radio is chosen', async () => {
      asPartnerAdmin();
      const recorded: RecordedRequest[] = [];
      installFetchRouter(
        {
          'GET /psa/connections': { data: [] },
          'POST /psa/connections': { id: 'c-new', provider: 'jira', name: 'Cust Jira', status: 'active', ownerScope: 'organization' },
        },
        recorded
      );

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      await user.click(screen.getByTestId('psa-connection-owner-org'));
      await user.type(screen.getByLabelText(/connection name/i), 'Cust Jira');
      await user.type(screen.getByLabelText(/instance url/i), 'https://acme.atlassian.net');
      await user.type(screen.getByLabelText(/username or email/i), 'admin@acme.com');
      await user.type(screen.getByLabelText(/api token/i), 'tok-123');
      await user.click(screen.getByRole('button', { name: /create connection/i }));

      await waitFor(() => expect(recorded).toHaveLength(1));
      expect((recorded[0]!.body as Record<string, unknown>).ownerScope).toBe('organization');
    });

    it('takes its create default from useDefaultOwnerScope, not a literal', async () => {
      // Review finding 4: with a concrete org selected the shared hook returns
      // 'organization', and this form must follow it rather than always
      // pre-selecting partner-wide.
      asPartnerAdmin();
      ownerScopeState.defaultOwnerScope = 'organization';
      orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }];
      orgStoreState.currentOrgId = 'org-1';
      installFetchRouter({ 'GET /psa/connections': { data: [] } }, []);

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      expect(screen.getByTestId('psa-connection-owner-org')).toBeChecked();
      expect(screen.getByTestId('psa-connection-owner-partner')).not.toBeChecked();
    });

    it('MULTI-ORG CREATE: sends orgId with the org-owned branch so the API does not 400', async () => {
      // Review finding 6: the "This organization only" radio previously sent no
      // orgId, so create failed for any partner with 2+ orgs.
      asPartnerAdmin();
      orgStoreState.organizations = [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Globex' },
      ];
      orgStoreState.currentOrgId = 'org-1';
      const recorded: RecordedRequest[] = [];
      installFetchRouter(
        {
          'GET /psa/connections': { data: [] },
          'POST /psa/connections': { id: 'c-new', provider: 'jira', name: 'Globex Jira', status: 'active', ownerScope: 'organization' },
        },
        recorded
      );

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      await user.click(screen.getByTestId('psa-connection-owner-org'));
      // The picker only appears on the org-owned branch.
      const picker = await screen.findByTestId('psa-connection-owner-org-select');
      await user.selectOptions(picker, 'org-2');

      await user.type(screen.getByLabelText(/connection name/i), 'Globex Jira');
      await user.type(screen.getByLabelText(/instance url/i), 'https://acme.atlassian.net');
      await user.type(screen.getByLabelText(/username or email/i), 'admin@acme.com');
      await user.type(screen.getByLabelText(/api token/i), 'tok-123');
      await user.click(screen.getByRole('button', { name: /create connection/i }));

      await waitFor(() => expect(recorded).toHaveLength(1));
      const body = recorded[0]!.body as Record<string, unknown>;
      expect(body.ownerScope).toBe('organization');
      expect(body.orgId).toBe('org-2');
    });

    it('hides the org picker on the partner-wide branch', async () => {
      asPartnerAdmin();
      orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }];
      installFetchRouter({ 'GET /psa/connections': { data: [] } }, []);

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      expect(screen.getByTestId('psa-connection-owner-partner')).toBeChecked();
      expect(screen.queryByTestId('psa-connection-owner-org-select')).toBeNull();
    });

    it('ROW ACTIONS: disables edit/pause/delete on a partner-wide row the user cannot manage', async () => {
      // Review finding 7: these used to render enabled and the click landed on
      // the server's new 403 as an error toast.
      jwtClaims.scope = 'partner';
      jwtClaims.partnerId = 'p-1';
      authUser.canManagePartnerWide = false;
      ownerScopeState.isPartnerScope = true;
      installFetchRouter(
        {
          'GET /psa/connections': {
            data: [{ id: 'c1', provider: 'jira', name: 'MSP Jira', status: 'active', ownerScope: 'partner' }],
          },
        },
        []
      );

      render(<PsaConnectionsPage />);

      await screen.findByText('MSP Jira');
      expect(screen.getByTestId('psa-connection-edit')).toBeDisabled();
      expect(screen.getByTestId('psa-connection-toggle')).toBeDisabled();
      expect(screen.getByTestId('psa-connection-delete')).toBeDisabled();
    });

    it('leaves row actions enabled on an ORG-owned row for the same restricted user', async () => {
      jwtClaims.scope = 'partner';
      jwtClaims.partnerId = 'p-1';
      authUser.canManagePartnerWide = false;
      ownerScopeState.isPartnerScope = true;
      installFetchRouter(
        {
          'GET /psa/connections': {
            data: [{ id: 'c2', provider: 'zendesk', name: 'Customer Zendesk', status: 'active', ownerScope: 'organization' }],
          },
        },
        []
      );

      render(<PsaConnectionsPage />);

      await screen.findByText('Customer Zendesk');
      expect(screen.getByTestId('psa-connection-edit')).toBeEnabled();
      expect(screen.getByTestId('psa-connection-delete')).toBeEnabled();
    });

    it('leaves row actions enabled on a partner-wide row for a FULL partner admin', async () => {
      asPartnerAdmin();
      installFetchRouter(
        {
          'GET /psa/connections': {
            data: [{ id: 'c1', provider: 'jira', name: 'MSP Jira', status: 'active', ownerScope: 'partner' }],
          },
        },
        []
      );

      render(<PsaConnectionsPage />);

      await screen.findByText('MSP Jira');
      expect(screen.getByTestId('psa-connection-edit')).toBeEnabled();
      expect(screen.getByTestId('psa-connection-delete')).toBeEnabled();
    });

    it('hides the selector for a partner user without the partner-wide capability', async () => {
      jwtClaims.scope = 'partner';
      jwtClaims.partnerId = 'p-1';
      authUser.canManagePartnerWide = false;
      ownerScopeState.isPartnerScope = true;
      ownerScopeState.defaultOwnerScope = 'partner';
      installFetchRouter({ 'GET /psa/connections': { data: [] } }, []);

      const user = userEvent.setup();
      render(<PsaConnectionsPage />);
      await user.click(await screen.findByRole('button', { name: /add connection/i }));

      expect(screen.queryByTestId('psa-connection-owner')).toBeNull();
    });
  });

  it('no longer offers a "Sync now" action (sync endpoint is an honest 501)', async () => {
    installFetchRouter(
      {
        'GET /psa/connections': {
          data: [{ id: 'c1', provider: 'jira', name: 'Primary', status: 'active' }],
        },
      },
      []
    );

    render(<PsaConnectionsPage />);

    await screen.findByRole('button', { name: /^edit$/i });
    expect(screen.queryByRole('button', { name: /sync now/i })).toBeNull();
  });
});
