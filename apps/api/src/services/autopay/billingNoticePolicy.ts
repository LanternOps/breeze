import { BILLING_NOTICE_KINDS, type BillingNoticeKind } from '@breeze/shared';

/**
 * BRZ-8807 notice matrix: with `partners.billing_enabled = false` no NEW money
 * movement is solicited, but existing obligations stay visible and communicated.
 * Exhaustive by construction: a new BillingNoticeKind fails to compile here.
 */
const BILLING_OFF_POLICY: Record<BillingNoticeKind, 'block' | 'keep'> = {
  autopay_request: 'block',
  card_expiring: 'block',
  invoice_autopay: 'block',
  payment_receipt: 'keep',
  payment_failed: 'keep',
  autopay_stopped: 'keep',
  autopay_enrolled: 'keep',
  autopay_paused: 'keep',
  autopay_resumed: 'keep',
  payment_reminder: 'keep',
  payment_overdue: 'keep',
};

export const BILLING_OFF_BLOCKED_NOTICE_KINDS: readonly BillingNoticeKind[] =
  BILLING_NOTICE_KINDS.filter(kind => BILLING_OFF_POLICY[kind] === 'block');

export const isBlockedWhileBillingOff = (kind: BillingNoticeKind): boolean =>
  BILLING_OFF_POLICY[kind] === 'block';
