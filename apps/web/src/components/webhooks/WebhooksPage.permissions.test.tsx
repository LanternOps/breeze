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
      ? []
      : [
          {
            id: 'wh-1',
            url: 'https://example.com/hook',
            events: ['device.created'],
            enabled: true,
            secret: null,
            payloadTemplate: null,
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

describe('WebhooksPage read is gated on webhooks:read', () => {
  it('shows the access-denied state and fetches nothing without webhooks:read', async () => {
    h.granted.add('organizations:read');
    render(<WebhooksPage />);
    expect(await screen.findByTestId('webhooks-access-denied')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Test event' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads webhooks with webhooks:read', async () => {
    h.granted.add('webhooks:read');
    render(<WebhooksPage />);
    expect(await screen.findByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
    expect(screen.queryByTestId('webhooks-access-denied')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/webhooks');
  });
});

describe('WebhooksPage New Webhook is permission-gated (#7215)', () => {
  it('hides New Webhook without organizations:write while the page still renders', async () => {
    h.granted.add('webhooks:read');
    render(<WebhooksPage />);
    expect(await screen.findByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new webhook/i })).toBeNull();
  });

  it('shows New Webhook with organizations:write', async () => {
    h.granted.add('webhooks:read');
    h.granted.add('organizations:write');
    render(<WebhooksPage />);
    expect(await screen.findByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new webhook/i })).toBeInTheDocument();
  });
});
