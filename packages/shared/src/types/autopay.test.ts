import { describe, expect, it } from 'vitest';
import * as vocabulary from './autopay';
import { ACTIVE_COLLECTION_ATTEMPT_STATES, RESERVING_COLLECTION_ATTEMPT_STATES, COLLECTION_ATTEMPT_STATES, BILLING_NOTICE_KINDS } from './autopay';

describe('autopay cross-wave vocabulary', () => {
  it('preserves active states and adds requires_action to the separate reservation set', () => {
    expect(ACTIVE_COLLECTION_ATTEMPT_STATES).toEqual(['reserved', 'created', 'confirming', 'processing']);
    expect(RESERVING_COLLECTION_ATTEMPT_STATES).toEqual([...ACTIVE_COLLECTION_ATTEMPT_STATES, 'requires_action']);
    expect(COLLECTION_ATTEMPT_STATES).toContain('requires_action');
    expect(COLLECTION_ATTEMPT_STATES).toContain('unapplied');
    expect(COLLECTION_ATTEMPT_STATES).toContain('canceled');
  });
  it('keeps every tuple duplicate-free and all nine notice kinds stable', () => {
    for (const values of Object.values(vocabulary)) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(BILLING_NOTICE_KINDS).toEqual(['autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring']);
  });
});
