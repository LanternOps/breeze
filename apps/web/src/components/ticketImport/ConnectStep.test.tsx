import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock, userState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: vi.fn(),
  userState: { id: 'user-me' as string },
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchMock,
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: userState.id } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import ConnectStep from './ConnectStep';
import { PRINCIPAL_ID, SOURCE_ID, json, sourceDetail } from './testFixtures';

const modules = [{ id: 'zammad', label: 'Zammad 7.2', optionsSchema: null }];

type Call = { url: string; method: string; body: unknown; init: Record<string, unknown> };
const calls = (): Call[] => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  method: String((init as { method?: string } | undefined)?.method ?? 'GET'),
  body: (init as { body?: string } | undefined)?.body ? JSON.parse((init as { body: string }).body) : undefined,
  init: (init ?? {}) as Record<string, unknown>,
}));
const posts = (path: string) => calls().filter((c) => c.method === 'POST' && c.url === path);

function route(handlers: Record<string, (body: unknown) => Response>) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = handlers[key];
    if (!handler) return json(404, { error: `unrouted ${key}` });
    return handler(init?.body ? JSON.parse(init.body) : undefined);
  });
}

function fill() {
  fireEvent.change(screen.getByTestId('ticket-import-connect-label'), { target: { value: 'Zammad' } });
  fireEvent.change(screen.getByTestId('ticket-import-connect-base-url'), { target: { value: 'https://helpdesk.example.com' } });
  fireEvent.change(screen.getByTestId('ticket-import-connect-token'), { target: { value: 'tok-secret' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  userState.id = 'user-me';
});

describe('ConnectStep — a new source (#8313 W6)', () => {
  it('creates an "Import: <label>" principal with tickets:write, then the source bound to it', async () => {
    route({
      'GET /partner-service-principals': () => json(200, { data: [] }),
      'POST /partner-service-principals': () => json(201, { data: { id: PRINCIPAL_ID } }),
      'POST /ticket-imports/sources': () => json(201, { data: { id: SOURCE_ID }, connect: { warnings: [] } }),
    });
    const onCreated = vi.fn();
    render(<ConnectStep modules={modules} sources={[]} source={null} onCreated={onCreated} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByTestId('ticket-import-connect-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(SOURCE_ID, { warnings: [] }));

    const [principal] = posts('/partner-service-principals');
    expect(principal!.body).toMatchObject({ name: 'Import: Zammad', scopes: ['tickets:write'] });
    const [source] = posts('/ticket-imports/sources');
    expect(source!.body).toEqual({
      module: 'zammad', label: 'Zammad', baseUrl: 'https://helpdesk.example.com',
      credentials: { token: 'tok-secret' }, principalId: PRINCIPAL_ID,
    });
    // Partner-wide: the header's org is never injected.
    expect(source!.init.skipOrgIdInjection).toBe(true);
    // The token is not kept once sent.
    expect(screen.getByTestId('ticket-import-connect-token')).toHaveValue('');
  });

  it('a refused source shows the refusal and a retry reuses the principal it created', async () => {
    let attempt = 0;
    route({
      'GET /partner-service-principals': () => json(200, { data: [] }),
      'POST /partner-service-principals': () => json(201, { data: { id: PRINCIPAL_ID } }),
      'POST /ticket-imports/sources': () => (++attempt === 1
        ? json(400, { error: 'The source refused the credentials', code: 'TICKET_IMPORT_INVALID_CREDENTIALS' })
        : json(201, { data: { id: SOURCE_ID } })),
    });
    const onCreated = vi.fn();
    render(<ConnectStep modules={modules} sources={[]} source={null} onCreated={onCreated} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByTestId('ticket-import-connect-submit'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'The help desk refused the token.' })));
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('ticket-import-connect-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posts('/partner-service-principals')).toHaveLength(1);
    expect(posts('/ticket-imports/sources').map((c) => (c.body as { principalId: string }).principalId)).toEqual([PRINCIPAL_ID, PRINCIPAL_ID]);
  });

  it('reuses a keyless principal the caller owns, without creating one', async () => {
    const reusable = { id: PRINCIPAL_ID, name: 'Import: old', status: 'active', scopes: ['tickets:write'], expiresAt: null, owner: { id: 'user-me', name: 'Me' }, keys: [] };
    const foreign = { ...reusable, id: 'p-foreign', name: 'Someone else', owner: { id: 'other', name: 'Other' } };
    route({
      'GET /partner-service-principals': () => json(200, { data: [reusable, foreign] }),
      'POST /ticket-imports/sources': () => json(201, { data: { id: SOURCE_ID } }),
    });
    render(<ConnectStep modules={modules} sources={[]} source={null} onCreated={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    fill();
    await waitFor(() => expect(screen.getByTestId('ticket-import-connect-principal-reuse')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('ticket-import-connect-principal-reuse'));
    const select = screen.getByTestId('ticket-import-connect-principal-select');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Choose a principal', 'Import: old']);
    expect(screen.getByTestId('ticket-import-connect-submit')).toBeDisabled();
    fireEvent.change(select, { target: { value: PRINCIPAL_ID } });
    fireEvent.click(screen.getByTestId('ticket-import-connect-submit'));
    await waitFor(() => expect(posts('/ticket-imports/sources')).toHaveLength(1));
    expect(posts('/partner-service-principals')).toHaveLength(0);
    expect((posts('/ticket-imports/sources')[0]!.body as { principalId: string }).principalId).toBe(PRINCIPAL_ID);
  });
});

describe('ConnectStep — an existing source (#8313 W6)', () => {
  it('lets the owner send a new token (reconnecting a revoked source) and never shows the stored one', async () => {
    route({ [`PATCH /ticket-imports/sources/${SOURCE_ID}`]: () => json(200, { data: {} }) });
    const onChanged = vi.fn();
    render(<ConnectStep modules={modules} sources={[]} source={sourceDetail({ hasCredentials: false, revokedAt: '2026-11-10T00:00:00.000Z' })}
      onCreated={vi.fn()} onChanged={onChanged} onDeleted={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-source-revoked')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-source-token')).toHaveValue('');
    expect(screen.getByTestId('ticket-import-source-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('ticket-import-source-token'), { target: { value: 'new-token' } });
    fireEvent.click(screen.getByTestId('ticket-import-source-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const patch = calls().find((c) => c.method === 'PATCH');
    expect(patch!.body).toEqual({ credentials: { token: 'new-token' } });
  });

  it('shows a non-owner the source without the edit form, and lets them revoke', async () => {
    userState.id = 'someone-else';
    route({ [`POST /ticket-imports/sources/${SOURCE_ID}/revoke`]: () => json(200, { data: {}, alreadyRevoked: false }) });
    const onChanged = vi.fn();
    render(<ConnectStep modules={modules} sources={[]} source={sourceDetail()} onCreated={vi.fn()} onChanged={onChanged} onDeleted={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-source-not-owner')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-import-source-save')).toBeNull();
    fireEvent.click(screen.getByTestId('ticket-import-source-revoke'));
    fireEvent.click(await screen.findByTestId('ticket-import-source-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(posts(`/ticket-imports/sources/${SOURCE_ID}/revoke`)).toHaveLength(1);
  });

  it('a delete refused while a run is active says so', async () => {
    route({ [`DELETE /ticket-imports/sources/${SOURCE_ID}`]: () => json(409, { error: 'A run is active', code: 'TICKET_IMPORT_RUN_ACTIVE' }) });
    const onDeleted = vi.fn();
    render(<ConnectStep modules={modules} sources={[]} source={sourceDetail()} onCreated={vi.fn()} onChanged={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByTestId('ticket-import-source-delete'));
    fireEvent.click(await screen.findByTestId('ticket-import-source-confirm'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'A run of this source is in progress. Wait for it or cancel it.',
    })));
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
