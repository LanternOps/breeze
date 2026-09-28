import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn((url: string) => {
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

beforeEach(() => h.granted.clear());

describe('WebhooksPage New Webhook is permission-gated (#7215)', () => {
  it('hides New Webhook without organizations:write while the page still renders', async () => {
    render(<WebhooksPage />);
    expect(await screen.findByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new webhook/i })).toBeNull();
  });

  it('shows New Webhook with organizations:write', async () => {
    h.granted.add('organizations:write');
    render(<WebhooksPage />);
    expect(await screen.findByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new webhook/i })).toBeInTheDocument();
  });
});
