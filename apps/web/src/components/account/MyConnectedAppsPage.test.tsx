import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./AccountSubNav', () => ({ default: () => null }));

import MyConnectedAppsPage from './MyConnectedAppsPage';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// The exact JSON GET /me/oauth-clients answers with (routes/lifecycle.ts).
const row = (clientId: string, toolListMode: unknown, over: Record<string, unknown> = {}) => ({
  clientId, displayName: clientId, createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null,
  lastApprovalDecidedAt: null, revokedAt: null, ...(toolListMode === undefined ? {} : { toolListMode }), ...over,
});
const uniform = (stored: 'full' | 'progressive' | null, mode: 'full' | 'progressive', grantCount = 1) => ({
  kind: 'uniform', stored, effective: { mode, source: stored ? 'credential' : 'deployment_default' }, grantCount,
});

function routeFetch(clients: unknown[], opts: { mcpToolListDefault?: string; patch?: { status: number; payload: unknown } } = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ clients, mcpToolListDefault: opts.mcpToolListDefault ?? 'full' });
    return jsonResponse(opts.patch?.payload ?? { updated: 1 }, opts.patch?.status ?? 200);
  });
}
const section = (clientId: string) => within(screen.getByTestId(`connection-tool-list-${clientId}`));
const field = (clientId: string) => section(clientId).getByTestId('mcp-tool-list-mode') as HTMLSelectElement;
const save = (clientId: string) => section(clientId).getByTestId('connection-tool-list-save');
const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

beforeEach(() => vi.clearAllMocks());

describe('MyConnectedAppsPage — MCP tool list (#12429)', () => {
  it('keeps each client\'s own mode and source from the GET, and shows the deployment default', async () => {
    routeFetch([row('app-a', uniform('progressive', 'progressive', 2)), row('app-b', uniform(null, 'progressive'))], { mcpToolListDefault: 'progressive' });
    render(<MyConnectedAppsPage />);
    await screen.findByTestId('connection-tool-list-app-a');
    expect(field('app-a').value).toBe('progressive');
    expect(section('app-a').getByTestId('mcp-tool-list-effective').textContent).toContain('Progressive — set on this connection');
    expect(field('app-b').value).toBe('inherit');
    expect(section('app-b').getByTestId('mcp-tool-list-effective').textContent).toContain('Progressive — deployment default');
    expect(section('app-b').getByText('Inherit (deployment default: Progressive)')).toBeTruthy();
    expect(section('app-a').getByText(/all of your active connections to this app, across all partners/)).toBeTruthy();
  });

  it('Save is off until something changed, then PATCHes that client and reloads', async () => {
    const id = 'https://app.example/client.json';
    routeFetch([row(id, uniform('full', 'full'))]);
    render(<MyConnectedAppsPage />);
    await screen.findByTestId(`connection-tool-list-${id}`);
    expect(save(id)).toBeDisabled();
    fireEvent.change(field(id), { target: { value: 'progressive' } });
    expect(save(id)).not.toBeDisabled();
    fireEvent.click(save(id));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]![0]).toBe(`/me/oauth-clients/${encodeURIComponent(id)}/mcp-tool-list-mode`);
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ mcp_tool_list_mode: 'progressive' });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('inherit is sent as null, and clearing shows what is inherited', async () => {
    routeFetch([row('app-a', uniform('full', 'full'))], { mcpToolListDefault: 'progressive' });
    render(<MyConnectedAppsPage />);
    await screen.findByTestId('connection-tool-list-app-a');
    fireEvent.change(field('app-a'), { target: { value: 'inherit' } });
    expect(section('app-a').getByTestId('mcp-tool-list-effective').textContent).toContain('Progressive — deployment default');
    fireEvent.click(save('app-a'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ mcp_tool_list_mode: null });
  });

  it('mixed shows Multiple values with Save disabled until an explicit choice (inherit included)', async () => {
    routeFetch([row('app-a', { kind: 'mixed', grantCount: 2 })]);
    render(<MyConnectedAppsPage />);
    await screen.findByTestId('connection-tool-list-app-a');
    expect(field('app-a').value).toBe('mixed');
    expect(section('app-a').getByText(/have different values/)).toBeTruthy();
    expect(save('app-a')).toBeDisabled();
    fireEvent.change(field('app-a'), { target: { value: 'inherit' } });
    expect(save('app-a')).not.toBeDisabled();
    fireEvent.click(save('app-a'));
    await waitFor(() => expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ mcp_tool_list_mode: null }));
  });

  it('a failed save toasts, keeps the choice and does not reload; a 401 goes to the session handler', async () => {
    routeFetch([row('app-a', uniform('full', 'full'))], { patch: { status: 404, payload: { error: 'No active connection to this OAuth client' } } });
    render(<MyConnectedAppsPage />);
    await screen.findByTestId('connection-tool-list-app-a');
    fireEvent.change(field('app-a'), { target: { value: 'progressive' } });
    fireEvent.click(save('app-a'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'No active connection to this OAuth client' })));
    expect(field('app-a').value).toBe('progressive');
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(1);

    routeFetch([], { patch: { status: 401, payload: {} } });
    fireEvent.click(save('app-a'));
    await waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
  });

  it('saving one app keeps another app\'s unsaved choice, and a failed refresh keeps the page', async () => {
    let gets = 0;
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') return jsonResponse({ updated: 1 });
      gets += 1;
      if (gets === 3) return jsonResponse({ error: 'Refresh failed' }, 500);
      const a = gets === 1 ? uniform('full', 'full') : uniform('progressive', 'progressive');
      return jsonResponse({ clients: [row('app-a', a), row('app-b', uniform('full', 'full'))], mcpToolListDefault: 'full' });
    });
    render(<MyConnectedAppsPage />);
    await screen.findByTestId('connection-tool-list-app-a');
    fireEvent.change(field('app-a'), { target: { value: 'progressive' } });
    fireEvent.change(field('app-b'), { target: { value: 'inherit' } });
    fireEvent.click(save('app-a'));
    await waitFor(() => expect(section('app-a').getByTestId('mcp-tool-list-effective').textContent).toBe('Shown now: Progressive — set on this connection'));
    expect(field('app-b').value).toBe('inherit');
    expect(save('app-b')).not.toBeDisabled();

    fireEvent.click(save('app-b'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Refresh failed' })));
    expect(screen.getByTestId('connection-tool-list-app-a')).toBeTruthy();
  });

  it('a stored value that changed elsewhere replaces the draft on refresh', async () => {
    let gets = 0;
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') return jsonResponse({ updated: 1 });
      gets += 1;
      return jsonResponse({ clients: [row('app-a', gets === 1 ? uniform('full', 'full') : { kind: 'mixed', grantCount: 2 })], mcpToolListDefault: 'full' });
    });
    render(<MyConnectedAppsPage />);
    await screen.findByTestId('connection-tool-list-app-a');
    fireEvent.change(field('app-a'), { target: { value: 'progressive' } });
    fireEvent.click(save('app-a'));
    await waitFor(() => expect(field('app-a').value).toBe('mixed'));
  });

  it('no control for a client with no active connection, a revoked one, or an API that does not send the mode', async () => {
    routeFetch([
      row('ended', { kind: 'none', grantCount: 0 }),
      row('revoked', { kind: 'none', grantCount: 0 }, { revokedAt: '2026-11-02T00:00:00.000Z' }),
      row('older-api', undefined),
    ]);
    render(<MyConnectedAppsPage />);
    await screen.findByText('ended');
    for (const id of ['ended', 'revoked', 'older-api']) expect(screen.queryByTestId(`connection-tool-list-${id}`)).toBeNull();
  });
});
