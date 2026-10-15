import '@/lib/i18n';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { QUICK_ADD_CHIPS, QuickAddChips } from './QuickAddChips';
import { decodeFilterFromHash, encodeFilterToHash } from './filterUrl';
import { getFieldDef } from './filterFields';

// Log-shipping health W04 (#8611): the "Log shipping failing" preset is a
// quick-filter chip over the server-side `logShippingFailing` field.
describe('"Log shipping failing" preset', () => {
  const condition = { field: 'logShippingFailing', operator: 'equals', value: 'yes' };

  it('is declared as a quick-filter chip over logShippingFailing = yes', () => {
    const chip = QUICK_ADD_CHIPS.find((c) => c.id === 'logShippingFailing');
    expect(chip).toBeDefined();
    expect(chip!.condition).toEqual(condition);
    expect(chip!.translationKey).toBe('quickAddChips.chips.logShippingFailing');
  });

  it('targets a field the filter catalog knows (yes/no boolean)', () => {
    const def = getFieldDef('logShippingFailing');
    expect(def?.type).toBe('boolean');
    expect(def?.operators).toEqual(['equals', 'notEquals']);
  });

  it('clicking the chip applies the filter, and it survives the URL hash round trip', () => {
    const onChange = vi.fn();
    render(<QuickAddChips value={null} onChange={onChange} />);

    const button = screen.getByTestId('quick-add-logShippingFailing');
    expect(button.textContent).toBe('Log Shipping Failing');
    fireEvent.click(button);

    const next = onChange.mock.calls[0]![0] as FilterConditionGroup;
    expect(next.conditions).toEqual([condition]);
    expect(decodeFilterFromHash(encodeFilterToHash(next))).toEqual(next);
  });
});
