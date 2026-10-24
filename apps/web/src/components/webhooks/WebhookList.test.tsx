import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import WebhookList from './WebhookList';

describe('WebhookList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<WebhookList webhooks={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });

  it('drops its own title when the host already names the panel', () => {
    render(<WebhookList webhooks={[]} showTitle={false} />);
    expect(screen.queryByRole('heading', { name: 'Webhooks' })).toBeNull();
    expect(screen.getByText(/0 of 0/)).toBeTruthy();
  });
});

describe('WebhookList delivery stats (#9656)', () => {
  it('reads lastDeliveryAt and renders success/failed counts', () => {
    render(
      <WebhookList
        webhooks={[
          {
            id: 'w1',
            name: 'Hook',
            url: 'https://example.com/h',
            events: ['device.online'],
            status: 'active',
            lastDeliveryAt: '2026-02-08T10:00:00.000Z',
            successCount: 7,
            failureCount: 2,
          },
        ]}
      />
    );
    expect(screen.getByText(/7 success/i)).toBeInTheDocument();
    expect(screen.getByText(/2 failed/i)).toBeInTheDocument();
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });
});
