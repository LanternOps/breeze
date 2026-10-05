import {expect,it} from 'vitest';
import {autopayReasonKey} from './autopayReason';
it('explains missing authorization separately from an unusable method',()=>{
  expect(autopayReasonKey('consent_required')).toBe('autopay.reasons.consent_required');
  expect(autopayReasonKey('consent_required')).not.toBe(autopayReasonKey('method_not_usable'));
});
it('tells staff an invoice is above the limit the client authorized, distinct from the MSP cap',()=>{
  expect(autopayReasonKey('above_authorized_cap')).toBe('autopay.reasons.above_authorized_cap');
  expect(autopayReasonKey('above_authorized_cap')).not.toBe(autopayReasonKey('over_cap'));
});
