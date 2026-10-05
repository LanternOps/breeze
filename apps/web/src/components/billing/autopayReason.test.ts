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
