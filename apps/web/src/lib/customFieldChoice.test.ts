import { describe, it, expect } from 'vitest';
import { dropdownChoiceLabel } from './customFieldChoice';

describe('dropdownChoiceLabel (#9677)', () => {
  const def = { type: 'dropdown', options: { choices: [{ label: 'Standard', value: 's' }, 'legacy'] } };

  it('maps object and legacy string choices', () => {
    expect(dropdownChoiceLabel(def, 's')).toBe('Standard');
    expect(dropdownChoiceLabel(def, 'legacy')).toBe('legacy');
  });
  it('falls back to the raw value for unknown values and missing options', () => {
    expect(dropdownChoiceLabel(def, 'gone')).toBe('gone');
    expect(dropdownChoiceLabel({ type: 'dropdown', options: null }, 'x')).toBe('x');
  });
  it('returns undefined for non-dropdown fields', () => {
    expect(dropdownChoiceLabel({ type: 'text' }, 'x')).toBeUndefined();
  });
});
