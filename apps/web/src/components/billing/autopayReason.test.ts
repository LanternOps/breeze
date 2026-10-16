import {expect,it} from 'vitest';
import {autopayReasonKey} from './autopayReason';
it('explains missing authorization separately from an unusable method',()=>{
  expect(autopayReasonKey('consent_required')).toBe('autopay.reasons.consent_required');
  expect(autopayReasonKey('consent_required')).not.toBe(autopayReasonKey('method_not_usable'));
});

import {chargeNowFailureKey,chargeNowSuccessKey,chargeNowAttempted} from './autopayReason';
it.each([
  [{data:{outcome:'created',state:'succeeded'}},'autopay.chargeOutcome.succeeded'],
  [{data:{outcome:'created',state:'processing'}},'autopay.chargeOutcome.processing'],
  [{data:{outcome:'created',state:'confirming'}},'autopay.chargeStarted'],
  [{data:{outcome:'created'}},'autopay.chargeStarted'],
])('maps a created charge to what actually happened',(body,key)=>expect(chargeNowSuccessKey(body)).toBe(key));
it.each([
  // Stripe reports 3DS as requires_payment_method + authentication_required, not requires_action.
  [{error:'authentication_required',code:'authentication_required',outcome:'requires_action'},'autopay.chargeOutcome.requiresAction'],
  [{error:'requires_action',code:'requires_action',outcome:'requires_action'},'autopay.chargeOutcome.requiresAction'],
  [{error:'card_declined',code:'card_declined',outcome:'failed'},'autopay.chargeOutcome.cardDeclined'],
  [{error:'expired_card',code:'expired_card',outcome:'failed'},'autopay.chargeOutcome.expiredCard'],
  [{error:'R01',code:'R01',outcome:'failed'},'autopay.chargeOutcome.insufficientFunds'],
  [{error:'processing_error',code:'processing_error',outcome:'failed'},'autopay.chargeOutcome.declined'],
  [{error:'canceled',code:'canceled',outcome:'canceled'},'autopay.chargeOutcome.canceled'],
  [{error:'unapplied',code:'unapplied',outcome:'unapplied'},'autopay.chargeOutcome.unapplied'],
  [{error:'collection_in_progress',code:'collection_in_progress',outcome:'deferred'},'autopay.chargeRefused.collection_in_progress'],
  [{error:'retry_not_due',code:'retry_not_due',outcome:'deferred'},'autopay.chargeRefused.retry_not_due'],
  [{error:'schedule_required',code:'schedule_required',outcome:'refused'},'autopay.chargeRefused.schedule_inactive'],
  [{error:'method_not_usable',code:'method_not_usable',outcome:'deferred'},'autopay.reasons.method_not_usable'],
  [{error:'consent_required',code:'consent_required',outcome:'refused'},'autopay.reasons.consent_required'],
  [{error:'something_new',code:'something_new',outcome:'refused'},'autopay.chargeRefused.generic'],
  // Route-level fences answer INVALID_STATE with the reason in error.
  [{error:'notice_lead',code:'INVALID_STATE'},'autopay.chargeRefused.notice_lead'],
  [{error:'Invoice has no eligible notice',code:'INVALID_STATE'},'autopay.chargeRefused.no_eligible_notice'],
  // An older API without outcome still never shows the raw code.
  [{error:'authentication_required',code:'authentication_required'},'autopay.chargeOutcome.requiresAction'],
])('maps charge refusal %j to staff copy',(body,key)=>expect(chargeNowFailureKey(body)).toBe(key));
it('leaves unrelated errors to the default message',()=>{
  expect(chargeNowFailureKey({error:'Forbidden',code:'ORG_DENIED'})).toBeUndefined();
  expect(chargeNowFailureKey(null)).toBeUndefined();
});
it('treats only outcomes that touched a payment as attempted',()=>{
  for(const outcome of ['failed','canceled','requires_action','unapplied'])expect(chargeNowAttempted({outcome})).toBe(true);
  for(const body of [{outcome:'deferred'},{outcome:'refused'},{error:'notice_lead'},null])expect(chargeNowAttempted(body)).toBe(false);
});
it('tells staff an invoice is above the limit the client authorized, distinct from the MSP cap',()=>{
  expect(autopayReasonKey('above_authorized_cap')).toBe('autopay.reasons.above_authorized_cap');
  expect(autopayReasonKey('above_authorized_cap')).not.toBe(autopayReasonKey('over_cap'));
});

import { chargeNowResultUnknown } from './autopayReason';
it('treats only answers that cannot say whether money moved as an unknown Charge now result (R4)', () => {
  expect(chargeNowResultUnknown({ status: 0 })).toBe(true);
  expect(chargeNowResultUnknown({ status: 504, body: null })).toBe(true);
  expect(chargeNowResultUnknown({ status: 500, body: { error: 'Internal server error' } })).toBe(true);
  expect(chargeNowResultUnknown({ status: 200 })).toBe(true);
  expect(chargeNowResultUnknown({ status: 401 })).toBe(false);
  expect(chargeNowResultUnknown({ status: 409, body: { error: 'card_declined', outcome: 'failed' } })).toBe(false);
  expect(chargeNowResultUnknown({ status: 409, body: { error: 'notice_lead', code: 'INVALID_STATE' } })).toBe(false);
});
it('names why Charge now was canceled when the attempt carries a reason (R3)', () => {
  expect(chargeNowFailureKey({ error: 'above_authorized_cap', code: 'above_authorized_cap', outcome: 'canceled' }))
    .toBe('autopay.reasons.above_authorized_cap');
  expect(chargeNowFailureKey({ error: 'canceled', code: 'canceled', outcome: 'canceled' })).toBe('autopay.chargeOutcome.canceled');
});

// F-8: an invoice issued before the client's updated authorization has its own staff wording.
it('names an invoice issued before the updated authorization', () => {
  expect(autopayReasonKey('issued_before_authorization')).toBe('autopay.reasons.issued_before_authorization');
});
// FP-17: Charge now on an excluded contract explains itself and what the client heard.
it('an excluded contract refusal has its own explanation', () => {
  expect(chargeNowFailureKey({ outcome: 'canceled', code: 'excluded_contract', error: 'excluded_contract' })).toBe('autopay.chargeRefused.excluded_contract');
});

it('does not report a charge result as unknown when the step-up could not be checked (nothing was attempted)', async () => {
  const { chargeNowResultUnknown } = await import('./autopayReason');
  expect(chargeNowResultUnknown({ status: 503, body: { code: 'STEP_UP_UNAVAILABLE' } })).toBe(false);
  expect(chargeNowResultUnknown({ status: 503, body: { error: 'x' } })).toBe(true);
});
