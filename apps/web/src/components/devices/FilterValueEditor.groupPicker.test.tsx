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

  const A = '33333333-3333-3333-3333-333333333333';
  const B = '44444444-4444-4444-4444-444444444444';
  const groups = [
    { id: A, name: 'Domain Controllers' },
    { id: B, name: 'Kiosks' }
  ];

  it('keeps notIn when a group is ticked (no silent flip to an inclusion)', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'notIn', value: [A] }}
        onChange={onChange}
        groups={groups}
      />
    );
    fireEvent.click(screen.getByTestId(`filter-group-picker-option-${B}`));
    expect(onChange.mock.calls[0][0]).toMatchObject({ operator: 'notIn', value: [A, B] });
  });

  it('keeps notIn when a selected group chip is removed', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'notIn', value: [A, B] }}
        onChange={onChange}
        groups={groups}
      />
    );
    fireEvent.click(screen.getByTestId(`filter-group-picker-remove-${A}`));
    expect(onChange.mock.calls[0][0]).toMatchObject({ operator: 'notIn', value: [B] });
  });

  it('keeps the negation of a scalar notEquals condition when editing (becomes notIn over an array)', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'notEquals', value: A }}
        onChange={onChange}
        groups={groups}
      />
    );
    fireEvent.click(screen.getByTestId(`filter-group-picker-option-${B}`));
    expect(onChange.mock.calls[0][0]).toMatchObject({ operator: 'notIn', value: [A, B] });
  });

  it('offers the any-of / none-of operator picker for Device Group and preserves the selection when switching', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'in', value: [A, B] }}
        onChange={onChange}
        groups={groups}
      />
    );
    const select = screen.getByTestId('filter-operator-select') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['in', 'notIn']);
    expect(select.value).toBe('in');
    fireEvent.change(select, { target: { value: 'notIn' } });
    expect(onChange.mock.calls[0][0]).toMatchObject({ operator: 'notIn', value: [A, B] });
  });

  it('shows none-of as selected for a scalar notEquals condition', () => {
    render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'notEquals', value: A }}
        onChange={vi.fn()}
        groups={groups}
      />
    );
    expect((screen.getByTestId('filter-operator-select') as HTMLSelectElement).value).toBe('notIn');
  });

  it('keeps in as in on toggle and renders no operator picker for org/site (only `in` offered)', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <FilterValueEditor
        field={getFieldDef('groupId')!}
        condition={{ field: 'groupId', operator: 'in', value: [A] }}
        onChange={onChange}
        groups={groups}
      />
    );
    fireEvent.click(screen.getByTestId(`filter-group-picker-option-${B}`));
    expect(onChange.mock.calls[0][0]).toMatchObject({ operator: 'in', value: [A, B] });
    unmount();

    render(
      <FilterValueEditor
        field={getFieldDef('siteId')!}
        condition={{ field: 'siteId', operator: 'in', value: [] }}
        onChange={vi.fn()}
        sites={groups}
      />
    );
    expect(screen.getByTestId('filter-site-picker')).toBeDefined();
    expect(screen.queryByTestId('filter-operator-select')).toBeNull();
  });
});
