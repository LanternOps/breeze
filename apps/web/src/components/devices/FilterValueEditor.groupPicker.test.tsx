import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilterValueEditor } from './FilterValueEditor';
import { getFieldDef } from './filterFields';

describe('FilterValueEditor — device group picker', () => {
  it('renders a searchable group name picker (not a raw UUID input) and stores ids', () => {
    const groups = [
      { id: '33333333-3333-3333-3333-333333333333', name: 'Domain Controllers' },
      { id: '44444444-4444-4444-4444-444444444444', name: 'Kiosks' }
    ];
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'in', value: [] }}
        onChange={onChange}
        groups={groups}
      />
    );
    expect(screen.getByTestId('filter-group-picker')).toBeDefined();
    expect(screen.getByTestId(`filter-group-picker-option-${groups[0].id}`).textContent).toContain('Domain Controllers');
    expect(screen.getByTestId(`filter-group-picker-option-${groups[1].id}`).textContent).toContain('Kiosks');

    fireEvent.click(screen.getByTestId(`filter-group-picker-option-${groups[1].id}`));
    const next = onChange.mock.calls[0][0];
    expect(next.operator).toBe('in');
    expect(next.value).toEqual([groups[1].id]);
  });
});
