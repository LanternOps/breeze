import { describe, expect, it } from 'vitest';
import { BILLING_NOTICE_KINDS } from '@breeze/shared';
import { BILLING_OFF_BLOCKED_NOTICE_KINDS, isBlockedWhileBillingOff } from './billingNoticePolicy';

describe('billingNoticePolicy', () => {
  it('classifies every BILLING_NOTICE_KIND as blocked or kept (new kind => red)', () => {
    const kept = BILLING_NOTICE_KINDS.filter(k => !isBlockedWhileBillingOff(k));
    expect([...BILLING_OFF_BLOCKED_NOTICE_KINDS, ...kept].sort()).toEqual([...BILLING_NOTICE_KINDS].sort());
  });
  it('blocks exactly the money-solicitation kinds', () => {
    expect([...BILLING_OFF_BLOCKED_NOTICE_KINDS].sort()).toEqual(['autopay_request', 'card_expiring', 'invoice_autopay']);
  });
});
