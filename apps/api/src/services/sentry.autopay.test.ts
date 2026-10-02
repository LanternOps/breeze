import { expect, it } from 'vitest';
import { scrubEvent } from './sentry';
it('preserves safe billing failure identity after scrubbing', () => {
  const tags = { service: 'billingNoticeOutbox', org_id: '11111111-1111-4111-8111-111111111111',
    billing_notice_id: '22222222-2222-4222-8222-222222222222', billing_notice_kind: 'autopay_request',
    autopay_phase: 'handler_failed', autopay_method_id: '33333333-3333-4333-8333-333333333333' };
  expect(scrubEvent({ tags }).tags).toEqual(tags);
});
