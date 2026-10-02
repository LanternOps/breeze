import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import WebhookDeliveryHistory, { normalizeDelivery } from './WebhookDeliveryHistory';

// The API (GET /webhooks/:id/deliveries) returns status ∈ pending|delivered|failed|retrying,
// createdAt and responseStatus. The table must render every one of them.
const apiRow = (status: string) => ({
  id: `d-${status}`,
  webhookId: 'w1',
  status,
  event: 'device.offline',
  responseStatus: status === 'delivered' ? 204 : null,
  attempt: 1,
  createdAt: '2026-10-02T12:00:00.000Z',
  deliveredAt: null,
});

describe('normalizeDelivery', () => {
  it('maps the API delivery shape onto the table row shape', () => {
    expect(normalizeDelivery(apiRow('delivered'))).toMatchObject({
      id: 'd-delivered',
      status: 'success',
      timestamp: '2026-10-02T12:00:00.000Z',
      responseCode: 204,
    });
    expect(normalizeDelivery(apiRow('retrying')).status).toBe('pending');
    expect(normalizeDelivery(apiRow('failed')).status).toBe('failed');
    expect(normalizeDelivery(apiRow('pending')).status).toBe('pending');
    expect(normalizeDelivery(apiRow('something-new')).status).toBe('pending');
  });
});

describe('WebhookDeliveryHistory', () => {
  it('renders delivered and retrying deliveries without crashing', () => {
    render(
      <WebhookDeliveryHistory
        deliveries={['delivered', 'retrying', 'failed'].map((s) => normalizeDelivery(apiRow(s)))}
      />
    );
    expect(screen.getByText('Success')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('HTTP 204')).toBeTruthy();
  });
});
