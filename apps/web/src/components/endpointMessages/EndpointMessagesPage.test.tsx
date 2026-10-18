import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EndpointMessagesPage from './EndpointMessagesPage';
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';

const granted = vi.hoisted(() => new Set<string>());

vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));

vi.mock('@/stores/auth', async () => {
  const actual = await vi.importActual<typeof import('@/stores/auth')>('@/stores/auth');
  return { ...actual, fetchWithAuth: vi.fn() };
});

vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return {
    ...actual,
    runAction: vi.fn(async (opts: { request: () => Promise<Response> }) => {
      const res = await opts.request();
      const data = await res.json();
      if (!res.ok) throw new actual.ActionError('failed', res.status, undefined, data);
      return data;
    }),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'm1', orgId: 'o1', batchId: 'b1', title: 'Reboot tonight', severity: 'warning', requiresAck: false,
    createdBy: 'u1', createdAt: '2026-10-10T10:00:00.000Z', expiresAt: '2026-10-11T10:00:00.000Z',
    retractedAt: null, bodyPurged: false, aiInitiated: false, resendOfId: null, deviceCount: 3,
    statusCounts: { displayed: 1, failed: 1, expired: 1 }, ...over,
  };
}

function delivery(over: Record<string, unknown> = {}) {
  return {
    id: 'd1', deviceId: 'dev1', hostname: 'host-1', siteId: 's1', status: 'displayed', surface: 'assist',
    errorCode: null, deliveredAt: '2026-10-10T10:01:00.000Z', displayedAt: '2026-10-10T10:02:00.000Z',
    acknowledgedAt: null, dismissedAt: null, retractedAt: null,
    receipts: [{ sessionUsername: 'alice', eventType: 'displayed', occurredAt: '2026-10-10T10:02:00.000Z' }], ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  return {
    ...item(), body: 'Please save your work.',
    deliveries: [
      delivery(),
      delivery({ id: 'd2', deviceId: 'dev2', hostname: 'host-2', status: 'failed', surface: null, errorCode: 'agent_unsupported', receipts: [] }),
      delivery({ id: 'd3', deviceId: 'dev3', hostname: 'host-3', status: 'expired', receipts: [] }),
    ],
    ...over,
  };
}

function route(map: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected request ${key}`);
    return hit[1]();
  });
}

describe('EndpointMessagesPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    runActionMock.mockClear();
    granted.clear();
    granted.add('endpoint_messages:read');
    granted.add('endpoint_messages:send');
    window.history.replaceState(null, '', '/endpoint-messages');
  });

  it('lists batches with severity, device count, status summary and badges; purged title is a placeholder', async () => {
    route({
      'GET /endpoint-messages?': () =>
        json({
          items: [
            item(),
            item({ id: 'm2', title: null, bodyPurged: true, retractedAt: '2026-10-10T12:00:00.000Z', aiInitiated: true }),
          ],
          nextCursor: null,
        }),
    });
    render(<EndpointMessagesPage />);
    const first = await screen.findByTestId('endpoint-message-row-m1');
    expect(first.textContent).toContain('Reboot tonight');
    expect(first.textContent).toContain('Warning');
    expect(first.textContent).toContain('Devices: 3');
    expect(first.textContent).toContain('Failed 1');
    const second = screen.getByTestId('endpoint-message-row-m2');
    expect(second.textContent).toContain('(content removed)');
    expect(within(second).getByText('Retracted')).toBeTruthy();
    expect(within(second).getByText('AI')).toBeTruthy();
    expect(screen.queryByTestId('endpoint-message-load-more')).toBeNull();
  });

  it('pages with nextCursor', async () => {
    route({
      'GET /endpoint-messages?limit=50&cursor=c1': () => json({ items: [item({ id: 'm9', title: 'Second page' })], nextCursor: null }),
      'GET /endpoint-messages?': () => json({ items: [item()], nextCursor: 'c1' }),
    });
    render(<EndpointMessagesPage />);
    await userEvent.click(await screen.findByTestId('endpoint-message-load-more'));
    await screen.findByTestId('endpoint-message-row-m9');
    expect(screen.getByTestId('endpoint-message-row-m1')).toBeTruthy();
  });

  it('selecting a batch writes it to the hash and shows body plus the per-device table', async () => {
    route({
      'GET /endpoint-messages/m1': () => json(detail()),
      'GET /endpoint-messages?': () => json({ items: [item()], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await userEvent.click(await screen.findByTestId('endpoint-message-row-m1'));
    expect(window.location.hash).toBe('#m1');
    await screen.findByTestId('endpoint-message-body');
    expect(screen.getByTestId('endpoint-message-body').textContent).toBe('Please save your work.');
    const row = screen.getByTestId('endpoint-delivery-row-d1');
    expect(row.textContent).toContain('host-1');
    expect(row.textContent).toContain('Displayed');
    expect(row.textContent).toContain('Assist card');
    expect(row.textContent).toContain('alice');
    expect(screen.getByTestId('endpoint-delivery-row-d2').textContent).toContain('agent_unsupported');
  });

  it('opens the batch named in the hash on load, and shows a purge notice for purged bodies', async () => {
    window.history.replaceState(null, '', '/endpoint-messages#m1');
    route({
      'GET /endpoint-messages/m1': () => json(detail({ title: null, body: null, bodyPurged: true })),
      'GET /endpoint-messages?': () => json({ items: [item({ title: null, bodyPurged: true })], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await screen.findByTestId('endpoint-message-purged');
    expect(screen.queryByTestId('endpoint-message-body')).toBeNull();
    expect(screen.queryByTestId('endpoint-message-resend')).toBeNull();
  });

  it('retract asks for confirmation, then POSTs through runAction and refreshes the detail', async () => {
    window.history.replaceState(null, '', '/endpoint-messages#m1');
    let retracted = false;
    route({
      'POST /endpoint-messages/m1/retract': () => {
        retracted = true;
        return json({ id: 'm1', retractedAt: '2026-10-10T13:00:00.000Z', alreadyRetracted: false, results: [{ deviceId: 'dev1', status: 'retracted', via: 'command' }] });
      },
      'GET /endpoint-messages/m1': () => json(detail(retracted ? { retractedAt: '2026-10-10T13:00:00.000Z' } : {})),
      'GET /endpoint-messages?': () => json({ items: [item()], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await userEvent.click(await screen.findByTestId('endpoint-message-retract'));
    expect(retracted).toBe(false);
    expect(runActionMock).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByTestId('endpoint-message-retract-confirm'));
    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('endpoint-message-retract')).toBeNull());
  });

  it('hides Retract when already retracted', async () => {
    window.history.replaceState(null, '', '/endpoint-messages#m1');
    route({
      'GET /endpoint-messages/m1': () => json(detail({ retractedAt: '2026-10-10T13:00:00.000Z' })),
      'GET /endpoint-messages?': () => json({ items: [item()], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await screen.findByTestId('endpoint-message-body');
    expect(screen.queryByTestId('endpoint-message-retract')).toBeNull();
    expect(screen.queryByTestId('endpoint-message-resend')).toBeNull();
  });

  it('resend posts a fresh uuid through runAction and only shows with failed/expired devices', async () => {
    window.history.replaceState(null, '', '/endpoint-messages#m1');
    route({
      'POST /endpoint-messages/m1/resend': () => json({ batchId: 'b2', deviceCount: 2, results: [] }),
      'GET /endpoint-messages/m1': () => json(detail()),
      'GET /endpoint-messages?': () => json({ items: [item()], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await userEvent.click(await screen.findByTestId('endpoint-message-resend'));
    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([u]) => u === '/endpoint-messages/m1/resend')!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).messageId).toMatch(UUID);
  });

  it('hides Resend when nothing failed or expired', async () => {
    window.history.replaceState(null, '', '/endpoint-messages#m1');
    route({
      'GET /endpoint-messages/m1': () => json(detail({ deliveries: [delivery()], statusCounts: { displayed: 1 } })),
      'GET /endpoint-messages?': () => json({ items: [item({ statusCounts: { displayed: 1 } })], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await screen.findByTestId('endpoint-message-retract');
    expect(screen.queryByTestId('endpoint-message-resend')).toBeNull();
  });

  it('hides the action buttons without endpoint_messages:send', async () => {
    granted.delete('endpoint_messages:send');
    window.history.replaceState(null, '', '/endpoint-messages#m1');
    route({
      'GET /endpoint-messages/m1': () => json(detail()),
      'GET /endpoint-messages?': () => json({ items: [item()], nextCursor: null }),
    });
    render(<EndpointMessagesPage />);
    await screen.findByTestId('endpoint-message-body');
    expect(screen.queryByTestId('endpoint-message-retract')).toBeNull();
    expect(screen.queryByTestId('endpoint-message-resend')).toBeNull();
  });

  it('shows a no-access notice and makes no requests without endpoint_messages:read', async () => {
    granted.clear();
    render(<EndpointMessagesPage />);
    expect(await screen.findByTestId('endpoint-messages-no-access')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
