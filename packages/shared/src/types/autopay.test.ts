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
  it('keeps every vocabulary tuple duplicate-free and all eleven notice kinds stable', () => {
    const tuples: readonly (readonly string[])[] = [
      vocabulary.AUTOPAY_ENROLLMENT_STATUSES,
      vocabulary.AUTOPAY_CANCEL_SOURCES,
      vocabulary.AUTOPAY_NEEDS_ATTENTION_REASONS,
      vocabulary.ACH_MODES,
      vocabulary.AUTOPAY_OFFSET_RULES,
      vocabulary.AUTOPAY_PAYMENT_METHOD_TYPES,
      vocabulary.CARD_FUNDING_TYPES,
      vocabulary.ACCOUNT_HOLDER_TYPES,
      vocabulary.ORG_PAYMENT_METHOD_STATUSES,
      vocabulary.AUTOPAY_SCHEDULE_STATES,
      vocabulary.AUTOPAY_INELIGIBLE_REASONS,
      vocabulary.COLLECTION_ATTEMPT_STATES,
      vocabulary.ACTIVE_COLLECTION_ATTEMPT_STATES,
      vocabulary.RESERVING_COLLECTION_ATTEMPT_STATES,
      vocabulary.COLLECTION_FAILURE_CLASSES,
      vocabulary.COLLECTION_ATTEMPT_INITIATORS,
      vocabulary.BILLING_NOTICE_KINDS,
      vocabulary.BILLING_NOTICE_STATUSES,
      vocabulary.BILLING_LINK_PURPOSES,
      vocabulary.CONSENT_SOURCES,
      vocabulary.AUTOPAY_SETUP_SOURCES,
      vocabulary.AUTOPAY_SETUP_OUTCOMES,
    ];
    for (const values of tuples) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(BILLING_NOTICE_KINDS).toEqual(['autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring', 'autopay_paused', 'autopay_resumed']);
  });
});
