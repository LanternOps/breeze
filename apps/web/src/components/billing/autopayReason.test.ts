import {expect,it} from 'vitest';
import {autopayReasonKey} from './autopayReason';
it('explains missing authorization separately from an unusable method',()=>{
  expect(autopayReasonKey('consent_required')).toBe('autopay.reasons.consent_required');
  expect(autopayReasonKey('consent_required')).not.toBe(autopayReasonKey('method_not_usable'));
});
