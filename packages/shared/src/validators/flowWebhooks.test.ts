import { describe, it, expect } from 'vitest';
import { FLOW_WEBHOOK_AUTH_FAILURES, FLOW_WEBHOOK_DELIVERY_ID_RE, FLOW_WEBHOOK_DELIVERY_STATUSES } from './flowWebhooks';

describe('flow webhooks (#5220)', () => {
  it('delivery-id regex accepts evt_123:abc and rejects 129 chars and spaces', () => {
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('evt_123:abc')).toBe(true);
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('a.b-c_d:e')).toBe(true);
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('a'.repeat(128))).toBe(true);
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('a'.repeat(129))).toBe(false);
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('evt 1')).toBe(false);
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('')).toBe(false);
    expect(FLOW_WEBHOOK_DELIVERY_ID_RE.test('a/b')).toBe(false);
  });

  it('lists statuses and auth failures', () => {
    expect([...FLOW_WEBHOOK_DELIVERY_STATUSES]).toEqual(['accepted', 'org_unresolved', 'refused', 'invalid_body']);
    expect([...FLOW_WEBHOOK_AUTH_FAILURES]).toEqual([
      'missing_signature', 'bad_signature', 'stale_timestamp', 'missing_token', 'bad_token', 'bad_delivery_id',
    ]);
  });
});
