import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PsaConnectionsPage from './PsaConnectionsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => 'https://us.2breeze.app'),
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
            hasCredentials: { password: false, apiToken: true, clientSecret: false },
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
