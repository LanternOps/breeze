import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { ADMISSION_REASON_CODES, admissionReasonMessage } from './admissionReason';

const t = i18n.getFixedT('en', 'scripts');

describe('admissionReasonMessage', () => {
  it('translates a known reason code instead of surfacing the raw token', () => {
    expect(admissionReasonMessage(t, 'script_org_mismatch')).toBe(
      'This script belongs to a different organization than the device',
    );
  });

  it('has a non-code message for every known code', () => {
    for (const code of ADMISSION_REASON_CODES) {
      const msg = admissionReasonMessage(t, code);
      expect(msg).not.toBe(code);
      expect(msg).not.toContain('scriptExecutionModal.');
    }
  });

  it('falls back to the raw code for an unknown reason', () => {
    expect(admissionReasonMessage(t, 'something_new')).toBe('something_new');
  });
});
