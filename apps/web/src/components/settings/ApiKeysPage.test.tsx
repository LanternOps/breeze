import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; organizations: unknown[] }) => unknown) =>
    selector({ currentOrgId: 'org-1', organizations: [] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ApiKeysPage from './ApiKeysPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const KEY = {
  id: 'key-1',
  name: 'CI deploy key',
  keyPrefix: 'brz_abc',
  scopes: ['devices:read'],
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
};

type Mutation = { status: number; payload: unknown };

function routeFetch(mutation: Mutation) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.startsWith('/api-keys')) {
      return jsonResponse({ data: [KEY], pagination: { page: 1, limit: 20, total: 1 } });
    }
    return jsonResponse(mutation.payload, mutation.status);
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api-keys?') && !init?.method).length;

async function renderPage() {
  render(<ApiKeysPage />);
  await screen.findByText('CI deploy key');
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('ApiKeysPage destructive confirmations (#3531)', () => {
  it('revoke failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Revoke blew up' } });
    await renderPage();
    expect(listFetches()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Revoke blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api-keys/key-1', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByText('Revoke API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Key' })).not.toBeDisabled();
    expect(listFetches()).toBe(1);
  });

  it('revoke success: refetches and closes the modal', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Key' }));

    await waitFor(() => expect(screen.queryByText('Revoke API Key')).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // #9950: the status flip in the row used to be the only confirmation.
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'API key "CI deploy key" revoked' }),
    );
  });

  it('revoke 404 (already gone): toasts, closes the modal, and refetches the list (sweep A2)', async () => {
    routeFetch({ status: 404, payload: { error: 'API key not found' } });
    await renderPage();
    expect(listFetches()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'API key not found' })),
    );
    await waitFor(() => expect(screen.queryByText('Revoke API Key')).toBeNull());
    expect(listFetches()).toBe(2);
  });

  it('rotate failure (403): toasts, keeps the modal open, does not refetch', async () => {
    routeFetch({ status: 403, payload: { error: 'Not allowed to rotate' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Not allowed to rotate' })),
    );
    expect(screen.getByText('Rotate API Key')).toBeInTheDocument();
    expect(screen.queryByText('Your API Key')).toBeNull();
    expect(listFetches()).toBe(1);
  });

  it('rotate success: closes the modal and still shows the new key', async () => {
    routeFetch({ status: 200, payload: { key: 'brz_new_secret_value' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate Key' }));

    await screen.findByDisplayValue('brz_new_secret_value');
    expect(screen.queryByText('Rotate API Key')).toBeNull();
    expect(listFetches()).toBe(2);
  });

  it('create failure: toasts, keeps the form open, does not refetch', async () => {
    routeFetch({ status: 500, payload: { error: 'Create blew up' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    const form = (await screen.findByPlaceholderText('My API Key')).closest('form')!;
    fireEvent.change(within(form).getByPlaceholderText('My API Key'), { target: { value: 'New key' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Select all' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Create blew up' })),
    );
    expect(screen.getByPlaceholderText('My API Key')).toHaveValue('New key');
    expect(listFetches()).toBe(1);
  });

  it('create success: closes the form and shows the created key', async () => {
    routeFetch({ status: 201, payload: { key: 'brz_created_secret' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    const form = (await screen.findByPlaceholderText('My API Key')).closest('form')!;
    fireEvent.change(within(form).getByPlaceholderText('My API Key'), { target: { value: 'New key' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Select all' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create Key' }));

    await screen.findByDisplayValue('brz_created_secret');
    expect(screen.queryByPlaceholderText('My API Key')).toBeNull();
    const createCall = fetchMock.mock.calls.find(([url, init]) => url === '/api-keys' && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ name: 'New key', orgId: 'org-1' });
    expect(listFetches()).toBe(2);
  });

  it('create POST body carries mcpDomains', async () => {
    routeFetch({ status: 201, payload: { key: 'brz_created_secret' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    const form = (await screen.findByPlaceholderText('My API Key')).closest('form')!;
    fireEvent.change(within(form).getByPlaceholderText('My API Key'), { target: { value: 'Narrow key' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Select all' }));
    fireEvent.click(within(form).getByTestId('mcp-domains-selected'));
    fireEvent.click(within(form).getByTestId('mcp-domain-tickets'));
    fireEvent.click(within(form).getByRole('button', { name: 'Create Key' }));

    await screen.findByDisplayValue('brz_created_secret');
    const createCall = fetchMock.mock.calls.find(([url, init]) => url === '/api-keys' && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: 'Narrow key',
      mcpDomains: ['tickets'],
    });
  });
});

describe('ApiKeysPage background refresh (#9656)', () => {
  it('keeps the rows and open modal visible while a refetch is in flight', async () => {
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let gets = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.startsWith('/api-keys')) {
        gets += 1;
        if (gets > 1) await gate;
        return jsonResponse({ data: [KEY], pagination: { page: 1, limit: 20, total: 1 } });
      }
      return jsonResponse({ key: 'brz_new_secret_value' });
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate Key' }));
    await screen.findByDisplayValue('brz_new_secret_value');

    // Refetch is pending: rows + the new-key modal must not blink out.
    expect(gets).toBe(2);
    expect(screen.getAllByText('CI deploy key').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('brz_new_secret_value')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();

    releaseSecond();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.getAllByText('CI deploy key').length).toBeGreaterThan(0);
  });

  it('first load shows the full-page spinner, not the inline refresh indicator', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    render(<ApiKeysPage />);
    expect(await screen.findByText('Loading API keys...')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('ApiKeysPage — MCP tool list mode (#12429)', () => {
  // The exact row GET /api-keys answers with (routes/apiKeys.ts).
  const AI_KEY = {
    ...KEY, scopes: ['ai:read'], lastUsedAt: null, expiresAt: null, rateLimit: 1000, mcpDomains: null,
    mcpToolListMode: 'full', mcpToolListModeEffective: { mode: 'full', source: 'credential' },
  };
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
  const select = () => screen.getByTestId('mcp-tool-list-mode') as HTMLSelectElement;
  const effectiveLine = () => screen.getByTestId('mcp-tool-list-effective').textContent;

  function route(key: Record<string, unknown>, opts: { mcpToolListDefault?: string; patch?: Mutation } = {}) {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse({ data: [key], pagination: { page: 1, limit: 20, total: 1 }, mcpToolListDefault: opts.mcpToolListDefault ?? 'full' });
      }
      return jsonResponse(opts.patch?.payload ?? {}, opts.patch?.status ?? 200);
    });
  }
  async function openView() {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByText('API Key Details');
  }

  it('the row keeps mcpToolListMode and mcpToolListModeEffective from the GET body', async () => {
    route({ ...AI_KEY, mcpToolListMode: null, mcpToolListModeEffective: { mode: 'progressive', source: 'deployment_default' } }, { mcpToolListDefault: 'progressive' });
    await openView();
    expect(select().value).toBe('inherit');
    expect(effectiveLine()).toContain('Progressive — deployment default');
    expect(screen.getByText('Inherit (deployment default: Progressive)')).toBeInTheDocument();
  });

  it('Save PATCHes only the mode, shows the new effective line and keeps the list row in step', async () => {
    route(AI_KEY, { patch: { status: 200, payload: { ...AI_KEY, mcpToolListMode: 'progressive', mcpToolListModeEffective: { mode: 'progressive', source: 'credential' } } } });
    await openView();
    const save = screen.getByTestId('api-key-tool-list-save');
    expect(save).toBeDisabled();
    fireEvent.change(select(), { target: { value: 'progressive' } });
    fireEvent.click(save);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]![0]).toBe('/api-keys/key-1');
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ mcpToolListMode: 'progressive' });
    await waitFor(() => expect(effectiveLine()).toContain('Progressive — set on this key'));
    expect(screen.getByTestId('api-key-tool-list-save')).toBeDisabled();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    // Reopening shows the saved value without a refetch.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(select().value).toBe('progressive');
  });

  it('inherit is sent as null; a failure toasts and keeps the choice', async () => {
    route(AI_KEY, { patch: { status: 403, payload: { error: 'MFA required' } } });
    await openView();
    fireEvent.change(select(), { target: { value: 'inherit' } });
    fireEvent.click(screen.getByTestId('api-key-tool-list-save'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ mcpToolListMode: null });
    expect(select().value).toBe('inherit');
    expect(screen.getByTestId('api-key-tool-list-save')).not.toBeDisabled();
  });

  it('a discarded choice does not survive closing the modal', async () => {
    route(AI_KEY);
    await openView();
    fireEvent.change(select(), { target: { value: 'progressive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(select().value).toBe('full');
  });

  it('no field on a key that cannot reach the MCP server; read-only on one that is no longer active', async () => {
    route({ ...AI_KEY, scopes: ['devices:read'] });
    await openView();
    expect(screen.queryByTestId('mcp-tool-list-mode')).toBeNull();
  });

  it('read-only (no Save) on a revoked key', async () => {
    route({ ...AI_KEY, status: 'revoked' });
    await openView();
    expect(select()).toBeDisabled();
    expect(screen.queryByTestId('api-key-tool-list-save')).toBeNull();
  });

  it('create: the form shows the deployment default and the POST carries the mode', async () => {
    route(AI_KEY, { mcpToolListDefault: 'progressive', patch: { status: 200, payload: { key: 'brz_new' } } });
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Key' })[0]!);
    const form = screen.getByText('Select all').closest('form')!;
    fireEvent.change(within(form).getByPlaceholderText('My API Key'), { target: { value: 'New key' } });
    fireEvent.click(within(form).getByText('Select all'));
    expect(within(form).getByText('Inherit (deployment default: Progressive)')).toBeInTheDocument();
    fireEvent.change(within(form).getByTestId('mcp-tool-list-mode'), { target: { value: 'full' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create Key' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ mcpToolListMode: 'full' });
  });
});
