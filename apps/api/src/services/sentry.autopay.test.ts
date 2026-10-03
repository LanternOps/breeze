import { expect, it } from 'vitest';
import { scrubEvent } from './sentry';
it('preserves safe billing failure identity after scrubbing', () => {
  const tags = { service: 'billingNoticeOutbox', org_id: '11111111-1111-4111-8111-111111111111',
    billing_notice_id: '22222222-2222-4222-8222-222222222222', billing_notice_kind: 'autopay_request',
    attempt_id:'44444444-4444-4444-8444-444444444444',invoice_id:'55555555-5555-4555-8555-555555555555',schedule_id:'66666666-6666-4666-8666-666666666666',
    return_identity:'77777777-7777-4777-8777-777777777777:dp_test',autopay_phase: 'handler_failed', autopay_method_id: '33333333-3333-4333-8333-333333333333' };
  expect(scrubEvent({ tags }).tags).toEqual(tags);
});
