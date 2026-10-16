import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchMock.mockImplementation((url: string) => {
    const data = String(url).endsWith('/deliveries')
      ? [
          {
            id: 'delivery-1',
            webhookId: 'wh-1',
            status: 'failed',
            event: 'device.created',
            responseStatus: 500,
            attempt: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]
      : [
          {
            id: 'wh-1',
            name: 'Alert relay',
            url: 'https://example.com/hook',
            events: ['device.created'],
            status: 'active',
            hasSecret: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ];
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) });
  }),
  handleSessionExpired: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

import WebhooksPage from './WebhooksPage';

beforeEach(() => {
  h.granted.clear();
  fetchMock.mockClear();
});

// Waits for the list and the selected webhook's delivery history to load.
async function renderLoaded() {
  render(<WebhooksPage />);
  await screen.findAllByText('Alert relay');
  await screen.findByText('HTTP 500');
}

// Every write control on the page, by accessible name. "Edit webhook" matches
// both the list row's icon button and the detail panel's button.
const WRITE_CONTROLS: Array<[string, RegExp]> = [
  ['New Webhook', /^new webhook$/i],
  ['list Test', /^test$/i],
  ['Edit webhook (list + detail)', /^edit webhook$/i],
  ['Delete webhook', /^delete webhook$/i],
  ['detail Test webhook', /^test webhook$/i],
  ['delivery Retry', /^retry$/i],
  ['status toggle', /^active$/i],
];

const renderedWriteControls = () =>
  WRITE_CONTROLS.filter(([, name]) => screen.queryAllByRole('button', { name }).length > 0).map(([label]) => label);

describe('WebhooksPage read is gated on webhooks:read', () => {
  it('shows the access-denied state and fetches nothing without webhooks:read', async () => {
    h.granted.add('organizations:read');
    render(<WebhooksPage />);
    expect(await screen.findByTestId('webhooks-access-denied')).toBeInTheDocument();
    expect(screen.queryByText('Alert relay')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads the list and delivery history with webhooks:read', async () => {
    h.granted.add('webhooks:read');
    await renderLoaded();
    expect(screen.queryByTestId('webhooks-access-denied')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/webhooks');
    expect(fetchMock).toHaveBeenCalledWith('/webhooks/wh-1/deliveries');
  });
});

describe('WebhooksPage write controls require organizations:write', () => {
  it('renders no write control for a read-only caller and sends no mutation', async () => {
    h.granted.add('webhooks:read');
    await renderLoaded();

    expect(renderedWriteControls()).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'Test event' })).toBeNull();
    // The status still shows, as text rather than a toggle.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.method).toBeUndefined();
    }
  });

  it('renders every write control with organizations:write', async () => {
    h.granted.add('webhooks:read');
    h.granted.add('organizations:write');
    await renderLoaded();

    expect(renderedWriteControls()).toEqual(WRITE_CONTROLS.map(([label]) => label));
    expect(screen.getAllByRole('button', { name: /^edit webhook$/i })).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
  });
});
