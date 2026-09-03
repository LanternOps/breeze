import { describe, it, expect } from 'vitest';
import { validateCustomFieldValue } from './validateValue';

const text = { fieldKey: 'note', type: 'text' as const, options: null };
const num = { fieldKey: 'slots', type: 'number' as const, options: { min: 0, max: 8 } };
const bool = { fieldKey: 'ready', type: 'boolean' as const, options: null };
const date = { fieldKey: 'expiry', type: 'date' as const, options: null };

describe('validateCustomFieldValue', () => {
  it('accepts a string for text and passes it through', () => {
    expect(validateCustomFieldValue(text, 'hello')).toEqual({ ok: true, value: 'hello' });
  });

  it('coerces number and boolean to text', () => {
    expect(validateCustomFieldValue(text, 42)).toEqual({ ok: true, value: '42' });
    expect(validateCustomFieldValue(text, true)).toEqual({ ok: true, value: 'true' });
  });

  it('rejects a text value over 10000 chars', () => {
    expect(validateCustomFieldValue(text, 'x'.repeat(10001))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('accepts a numeric string for number and returns a number', () => {
    expect(validateCustomFieldValue(num, '4')).toEqual({ ok: true, value: 4 });
  });

  it('rejects a non-numeric string for number', () => {
    expect(validateCustomFieldValue(num, 'four')).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('rejects a boolean for number rather than coercing true to 1', () => {
    // Number(true) === 1. Without the explicit boolean guard a script emitting
    // a flag for a numeric field silently stores 0/1 instead of being rejected.
    expect(validateCustomFieldValue(num, true)).toEqual({ ok: false, reason: 'invalid_type' });
    expect(validateCustomFieldValue(num, false)).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('rejects an empty/whitespace string for number rather than coercing to 0', () => {
    // Number('') === 0 and Number('   ') === 0.
    expect(validateCustomFieldValue(num, '')).toEqual({ ok: false, reason: 'invalid_type' });
    expect(validateCustomFieldValue(num, '   ')).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('rejects non-finite numeric input', () => {
    expect(validateCustomFieldValue(num, Number.NaN)).toEqual({ ok: false, reason: 'invalid_type' });
    expect(validateCustomFieldValue(num, Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      reason: 'invalid_type',
    });
  });

  it('enforces number min/max from options', () => {
    expect(validateCustomFieldValue(num, 9)).toEqual({ ok: false, reason: 'out_of_range' });
    expect(validateCustomFieldValue(num, -1)).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('accepts true/false strings for boolean', () => {
    expect(validateCustomFieldValue(bool, 'true')).toEqual({ ok: true, value: true });
    expect(validateCustomFieldValue(bool, 'FALSE')).toEqual({ ok: true, value: false });
  });

  it('rejects an arbitrary string for boolean', () => {
    expect(validateCustomFieldValue(bool, 'yes')).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('accepts an ISO date and normalises to YYYY-MM-DD', () => {
    expect(validateCustomFieldValue(date, '2026-12-31T00:00:00Z')).toEqual({ ok: true, value: '2026-12-31' });
  });

  it('rejects a non-date string', () => {
    expect(validateCustomFieldValue(date, 'soon')).toEqual({ ok: false, reason: 'invalid_date' });
  });

  it('accepts a dropdown choice in the string-array options shape', () => {
    const dd = { fieldKey: 'tier', type: 'dropdown' as const, options: { choices: ['gold', 'silver'] } };
    expect(validateCustomFieldValue(dd, 'gold')).toEqual({ ok: true, value: 'gold' });
    expect(validateCustomFieldValue(dd, 'bronze')).toEqual({ ok: false, reason: 'not_a_choice' });
  });

  it('accepts a dropdown choice in the {label,value} options shape', () => {
    const dd = {
      fieldKey: 'tier',
      type: 'dropdown' as const,
      options: { choices: [{ label: 'Gold', value: 'gold' }] },
    };
    expect(validateCustomFieldValue(dd, 'gold')).toEqual({ ok: true, value: 'gold' });
    expect(validateCustomFieldValue(dd, 'Gold')).toEqual({ ok: false, reason: 'not_a_choice' });
  });

  it('treats malformed options as no constraint rather than throwing', () => {
    const dd = { fieldKey: 'tier', type: 'dropdown' as const, options: { choices: 'gold' } };
    expect(validateCustomFieldValue(dd, 'anything')).toEqual({ ok: true, value: 'anything' });
  });

  it('passes null through for every type as an explicit clear', () => {
    for (const def of [text, num, bool, date]) {
      expect(validateCustomFieldValue(def, null)).toEqual({ ok: true, value: null });
    }
  });

  it('rejects objects and arrays outright', () => {
    expect(validateCustomFieldValue(text, { a: 1 })).toEqual({ ok: false, reason: 'invalid_type' });
    expect(validateCustomFieldValue(text, [1])).toEqual({ ok: false, reason: 'invalid_type' });
  });
});
