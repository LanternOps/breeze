import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn((url: string) => {
    if (String(url).startsWith('/webhooks/') && String(url).endsWith('/deliveries')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({ data: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        data: [
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
        ],
      }),
    });
  }),
  handleSessionExpired: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

import WebhooksPage from './WebhooksPage';

describe('WebhooksPage test-event select accessible name (#7156)', () => {
  it('gives the test-event select a real accessible name once a webhook is active', async () => {
    render(<WebhooksPage />);
    expect(await screen.findByRole('combobox', { name: 'Test event' })).toBeInTheDocument();
  });
});
