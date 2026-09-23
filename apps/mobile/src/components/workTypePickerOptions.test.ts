import { describe, expect, it } from 'vitest';

import { workTypePickerOptions, isWorkTypeOptionSelected } from './workTypePickerOptions';

const TYPES = [
  { id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 },
  { id: 'wt-2', name: 'On-site', isActive: true, sortOrder: 2 },
];

describe('workTypePickerOptions (#4628 W04)', () => {
  it('leads with a "Default" option whose value is undefined, then one option per work type', () => {
    expect(workTypePickerOptions(TYPES)).toEqual([
      { key: 'default', label: 'Default', value: undefined },
      { key: 'wt-1', label: 'Remote', value: 'wt-1' },
      { key: 'wt-2', label: 'On-site', value: 'wt-2' },
    ]);
  });

  it('"Default" is undefined, NOT null — so the start omits the field and the server applies the category default (§3.1)', () => {
    const [first] = workTypePickerOptions(TYPES);
    expect(first.value).toBeUndefined();
  });

  it('offers no options at all when the partner has no work types — no empty control', () => {
    expect(workTypePickerOptions([])).toEqual([]);
  });

  it('marks exactly the chosen option selected, and Default when nothing was chosen', () => {
    const options = workTypePickerOptions(TYPES);
    expect(options.filter((o) => isWorkTypeOptionSelected(o, 'wt-2')).map((o) => o.key)).toEqual(['wt-2']);
    expect(options.filter((o) => isWorkTypeOptionSelected(o, undefined)).map((o) => o.key)).toEqual(['default']);
  });
});
