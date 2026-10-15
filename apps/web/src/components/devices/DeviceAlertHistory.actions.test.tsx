/**
 * #8137 — the device Alerts tab must show alert status and offer
 * Acknowledge / Resolve / Suppress (permission-gated, via the shared
 * useAlertActions hook) and link each row to /alerts/<id>.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';
import DeviceAlertHistory from './DeviceAlertHistory';

const h = vi.hoisted(() => ({
  granted: new Set<string>(),
  fetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: h.fetch };
});
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => h.toast(a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const json = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (id: string, status: string) => ({
  id,
  title: `Alert ${id}`,
  message: `Message ${id}`,
  severity: 'warning',
  status,
  createdAt: '2026-02-09T09:00:00.000Z',
});

let rows: ReturnType<typeof row>[];
let listCalls: number;
let actionResponse: () => Response;

beforeEach(() => {
  vi.clearAllMocks();
  h.granted.clear();
  listCalls = 0;
  rows = [row('a1', 'active'), row('a2', 'acknowledged'), row('a3', 'resolved'), row('a4', 'suppressed')];
  actionResponse = () => json({ success: true });
  h.fetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.startsWith('/devices/dev-1/alerts')) {
      listCalls += 1;
      return Promise.resolve(json({ data: rows }));
    }
    if (method === 'POST' && url.startsWith('/alerts/')) return Promise.resolve(actionResponse());
    return Promise.resolve(json({ error: 'unexpected' }, false, 404));
  });
});

const renderIt = async () => {
  render(<DeviceAlertHistory deviceId="dev-1" timezone="UTC" />);
  await screen.findByTestId('device-alert-row-a1');
};
const btn = (kind: string, id: string) => screen.queryByTestId(`device-alert-${kind}-${id}`);

describe('DeviceAlertHistory — status + link', () => {
  it('shows a status badge on every row and links the title to /alerts/<id>', async () => {
    await renderIt();
    expect(screen.getByTestId('device-alert-status-a1')).toHaveTextContent('Active');
    expect(screen.getByTestId('device-alert-status-a2')).toHaveTextContent('Acknowledged');
    expect(screen.getByTestId('device-alert-status-a3')).toHaveTextContent('Resolved');
    expect(screen.getByTestId('device-alert-status-a4')).toHaveTextContent('Suppressed');
    expect(screen.getByTestId('device-alert-link-a1')).toHaveAttribute('href', '/alerts/a1');
  });
});

describe('DeviceAlertHistory — buttons by status and permission', () => {
  it('renders no action buttons without permissions', async () => {
    await renderIt();
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      for (const k of ['ack', 'resolve', 'suppress']) expect(btn(k, id)).toBeNull();
    }
  });

  it('alerts:acknowledge grants Ack on active rows only', async () => {
    h.granted.add('alerts:acknowledge');
    await renderIt();
    expect(btn('ack', 'a1')).not.toBeNull();
    expect(btn('ack', 'a2')).toBeNull();
    expect(btn('ack', 'a3')).toBeNull();
    expect(btn('resolve', 'a1')).toBeNull();
    expect(btn('suppress', 'a1')).toBeNull();
  });

  it('alerts:write grants Resolve (active/ack) and Suppress (not resolved/suppressed), not Ack', async () => {
    h.granted.add('alerts:write');
    await renderIt();
    expect(btn('ack', 'a1')).toBeNull();
    expect(btn('resolve', 'a1')).not.toBeNull();
    expect(btn('resolve', 'a2')).not.toBeNull();
    expect(btn('resolve', 'a3')).toBeNull();
    expect(btn('resolve', 'a4')).toBeNull();
    expect(btn('suppress', 'a1')).not.toBeNull();
    expect(btn('suppress', 'a2')).not.toBeNull();
    expect(btn('suppress', 'a3')).toBeNull();
    expect(btn('suppress', 'a4')).toBeNull();
  });
});

describe('DeviceAlertHistory — actions refetch the device list', () => {
  it('acknowledge POSTs and refetches', async () => {
    h.granted.add('alerts:acknowledge');
    await renderIt();
    fireEvent.click(btn('ack', 'a1')!);
    await waitFor(() =>
      expect(h.fetch).toHaveBeenCalledWith('/alerts/a1/acknowledge', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('resolve asks for a note, POSTs it, and refetches', async () => {
    h.granted.add('alerts:write');
    await renderIt();
    fireEvent.click(btn('resolve', 'a1')!);
    fireEvent.change(screen.getByTestId('device-alert-resolve-note-a1'), { target: { value: 'rebooted' } });
    fireEvent.click(screen.getByTestId('device-alert-resolve-confirm-a1'));
    await waitFor(() =>
      expect(h.fetch).toHaveBeenCalledWith(
        '/alerts/a1/resolve',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'rebooted' }) }),
      ),
    );
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('a 409 on resolve refreshes the list instead of leaving a stale Resolve button', async () => {
    h.granted.add('alerts:write');
    actionResponse = () => json({ error: 'already resolved' }, false, 409);
    await renderIt();
    fireEvent.click(btn('resolve', 'a1')!);
    fireEvent.click(screen.getByTestId('device-alert-resolve-confirm-a1'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('a 500 on resolve does not refetch', async () => {
    h.granted.add('alerts:write');
    actionResponse = () => json({ error: 'boom' }, false, 500);
    await renderIt();
    fireEvent.click(btn('resolve', 'a1')!);
    fireEvent.click(screen.getByTestId('device-alert-resolve-confirm-a1'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(listCalls).toBe(1);
  });

  it('a failed post-action refetch keeps the list (no error screen)', async () => {
    h.granted.add('alerts:acknowledge');
    await renderIt();
    h.fetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(json({ error: 'down' }, false, 500));
      return Promise.resolve(json({ success: true }));
    });
    fireEvent.click(btn('ack', 'a1')!);
    await waitFor(() => expect(screen.getByTestId('device-alert-status-a1')).toHaveTextContent('Acknowledged'));
    expect(screen.queryByText(/Failed to fetch alert history/i)).toBeNull();
    expect(screen.getByTestId('device-alert-row-a2')).toBeInTheDocument();
  });

  it('acknowledge failure toasts and does not refetch', async () => {
    h.granted.add('alerts:acknowledge');
    actionResponse = () => json({ error: 'nope' }, false, 500);
    await renderIt();
    fireEvent.click(btn('ack', 'a1')!);
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(listCalls).toBe(1);
    expect(screen.getByTestId('device-alert-status-a1')).toHaveTextContent('Active');
  });

  it('suppress failure reverts the optimistic badge and shows the server reason', async () => {
    h.granted.add('alerts:write');
    actionResponse = () => json({ error: 'Cannot suppress a resolved alert' }, false, 409);
    await renderIt();
    fireEvent.click(btn('suppress', 'a1')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^suppress$/i }));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Cannot suppress a resolved alert' }),
      ),
    );
    expect(screen.getByTestId('device-alert-status-a1')).toHaveTextContent('Active');
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2)); // 409 re-syncs from the server
  });

  it('undo reverts an optimistic suppress and the request carries an `until`', async () => {
    h.granted.add('alerts:write');
    await renderIt();
    fireEvent.click(btn('suppress', 'a1')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^suppress$/i }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'undo' })));
    const post = h.fetch.mock.calls.find(([u]) => u === '/alerts/a1/suppress')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ until: expect.any(String) });
    const undo = h.toast.mock.calls.map((c) => c[0]).find((a) => a.type === 'undo');
    undo.onUndo();
    await waitFor(() => expect(screen.getByTestId('device-alert-status-a1')).toHaveTextContent('Active'));
  });

  it('suppress dialog confirm: happy path POSTs and refetches', async () => {
    h.granted.add('alerts:write');
    await renderIt();
    fireEvent.click(btn('suppress', 'a1')!);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getAllByRole('button').find((b) => /suppress|mute/i.test(b.textContent ?? '') && !/cancel/i.test(b.textContent ?? ''));
    fireEvent.click(confirm!);
    await waitFor(() =>
      expect(h.fetch).toHaveBeenCalledWith('/alerts/a1/suppress', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'undo' }));
  });
});
