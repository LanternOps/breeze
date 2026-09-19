import { describe, expect, it } from 'vitest';
import {
  BREEZE_PAYMENT_NOTE_PREFIX, buildPaymentPrivateNote, parseBreezePaymentMarker, paymentMappingRemoteId,
} from './accountingPaymentMarker';

const ID = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('Breeze payment PrivateNote marker (spec decision 3)', () => {
  it('round-trips a payment id', () => {
    expect(buildPaymentPrivateNote(ID)).toBe(`${BREEZE_PAYMENT_NOTE_PREFIX}${ID}`);
    expect(parseBreezePaymentMarker(buildPaymentPrivateNote(ID))).toBe(ID);
  });

  it('is ANCHORED — a note that merely contains the marker is not a claim', () => {
    // An operator can type anything into PrivateNote. Only a note that IS the
    // marker, start to end, may hand a QuickBooks Payment ownership of a Breeze
    // payment row; a substring match would let a copied note steal a mapping.
    expect(parseBreezePaymentMarker(`See ${BREEZE_PAYMENT_NOTE_PREFIX}${ID}`)).toBeNull();
    expect(parseBreezePaymentMarker(`${BREEZE_PAYMENT_NOTE_PREFIX}${ID} (re-keyed)`)).toBeNull();
  });

  it('rejects a non-uuid payload, empty notes, and absent notes', () => {
    expect(parseBreezePaymentMarker(`${BREEZE_PAYMENT_NOTE_PREFIX}not-a-uuid`)).toBeNull();
    expect(parseBreezePaymentMarker(`${BREEZE_PAYMENT_NOTE_PREFIX}${ID.toUpperCase()}`)).toBeNull();
    expect(parseBreezePaymentMarker('')).toBeNull();
    expect(parseBreezePaymentMarker(null)).toBeNull();
    expect(parseBreezePaymentMarker(undefined)).toBeNull();
  });

  it('tolerates the whitespace QuickBooks round-trips through its UI', () => {
    expect(parseBreezePaymentMarker(`  ${BREEZE_PAYMENT_NOTE_PREFIX}${ID}\n`)).toBe(ID);
  });
});

describe('paymentMappingRemoteId (moved here from accountingPaymentPull.ts)', () => {
  it('qualifies the QuickBooks Payment id by the invoice it settles', () => {
    // A bare Payment id would let only the FIRST line of a split payment claim a
    // mapping; the rest would collide on accounting_entity_mappings_remote_uniq.
    expect(paymentMappingRemoteId('181', '145')).toBe('181/145');
    expect(paymentMappingRemoteId('181', '146')).toBe('181/146');
  });
});
