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

const bank = { invoiceId: '10000000-0000-4000-8000-000000000001', orgId: '20000000-0000-4000-8000-000000000001',
  principal: '100.00', fee: '0.00', currency: 'USD', disclosureHash: 'a'.repeat(64) };
const collection = { attemptId: '30000000-0000-4000-8000-000000000001',
  methodId: '40000000-0000-4000-8000-000000000001', stripePaymentMethodId: 'pm_bank',
  setupIntentId: 'seti_bank', accountHolderType: 'individual' };
const bankSchema = vocabulary.autopayConsentSnapshotSchema.shape.bankPayment;

it('validates bank consent amounts without a collection binding before reservation', () => {
  expect(bankSchema.safeParse(bank).success).toBe(true);
  expect(bankSchema.safeParse(undefined).success).toBe(true);
  expect(bankSchema.safeParse(null).success).toBe(true);
  for (const patch of [{ principal: 100 }, { fee: '-1.00' }, { currency: 'EUR' }, { invoiceId: 'bad' }, { disclosureHash: '' }]) {
    expect(bankSchema.safeParse({ ...bank, ...patch }).success).toBe(false);
  }
});

it('rejects reservation-time mutations of immutable bank consent', () => {
  expect(bankSchema.safeParse({ ...bank, collection }).success).toBe(false);
});
