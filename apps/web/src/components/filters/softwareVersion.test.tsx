import '@/lib/i18n';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilterCondition, FilterValue } from '@breeze/shared';
import { ValueInput } from './ValueInput';
import { ConditionRow } from './ConditionRow';
import { OperatorSelector } from './OperatorSelector';
import { FILTER_FIELDS } from './filterFields';
import { FilterValueEditor, summarizeCondition } from '../devices/FilterValueEditor';
import { defaultConditionForField } from '../devices/FilterChipBar';

const versionField = () => FILTER_FIELDS.find(f => f.key === 'software.version')!;

describe('software version filters', () => {
  it('edits the software name and version as a compound value', () => {
    const changed = vi.fn();
    function Editor() {
      const [value, setValue] = useState<FilterValue>({ name: '', version: '' });
      return <ValueInput field={versionField()} operator="below" value={value} onChange={next => { setValue(next); changed(next); }} />;
    }
    render(<Editor />);
    fireEvent.change(screen.getByTestId('software-version-name-input'), { target: { value: 'Chrome' } });
    fireEvent.change(screen.getByTestId('software-version-value-input'), { target: { value: '130.0' } });
    expect(changed).toHaveBeenLastCalledWith({ name: 'Chrome', version: '130.0' });
    expect(screen.getByTestId('software-version-name-input')).toHaveAttribute('maxLength', '500');
    expect(screen.getByTestId('software-version-value-input')).toHaveAttribute('maxLength', '100');
  });

  it('offers exactly below, at least and equals for version rules', () => {
    const field = versionField();
    render(<OperatorSelector value="below" operators={field.operators} fieldType={field.type} onChange={vi.fn()} />);
    expect(screen.getAllByRole('option').map(o => [o.getAttribute('value'), o.textContent])).toEqual([
      ['below', 'below'], ['atLeast', 'at least'], ['equals', 'equals']
    ]);
    expect(FILTER_FIELDS.find(f => f.key === 'software.vendor')?.operators).toEqual(['contains', 'equals']);
    expect(FILTER_FIELDS.filter(f => f.operators.some(op => op === 'below' || op === 'atLeast')).map(f => f.key)).toEqual(['software.version']);
  });

  it('resets to an empty compound value on field selection and retains it across compatible operators', () => {
    const changed = vi.fn();
    function Row() {
      const [value, setValue] = useState<FilterCondition>({ field: 'hostname', operator: 'contains', value: 'old' });
      return <ConditionRow value={value} filterFields={FILTER_FIELDS} onChange={next => { setValue(next); changed(next); }} onRemove={vi.fn()} />;
    }
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: /Hostname/ }));
    fireEvent.click(screen.getByText('Software Version'));
    expect(changed).toHaveBeenLastCalledWith({ field: 'software.version', operator: 'below', value: { name: '', version: '' } });
    fireEvent.change(screen.getByTestId('software-version-name-input'), { target: { value: 'Chrome' } });
    fireEvent.change(screen.getByTestId('software-version-value-input'), { target: { value: '130' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'atLeast' } });
    expect(changed).toHaveBeenLastCalledWith({ field: 'software.version', operator: 'atLeast', value: { name: 'Chrome', version: '130' } });
    fireEvent.click(screen.getByRole('button', { name: /Software Version/ }));
    fireEvent.click(screen.getByText('Software Vendor'));
    expect(changed).toHaveBeenLastCalledWith({ field: 'software.vendor', operator: 'contains', value: '' });
    expect(screen.getByTestId('value-text-input')).toHaveValue('');
    expect(screen.queryByTestId('software-version-name-input')).not.toBeInTheDocument();
  });

  it('supports the chip editor and displays compound values without object stringification', () => {
    const field = versionField();
    expect(defaultConditionForField(field)).toEqual({ field: 'software.version', operator: 'below', value: { name: '', version: '' } });
    const condition: FilterCondition = { field: field.key, operator: 'below', value: { name: 'Chrome', version: '130' } };
    render(<FilterValueEditor field={field} condition={condition} onChange={vi.fn()} />);
    expect(screen.getByTestId('software-version-name-input')).toHaveValue('Chrome');
    expect(within(screen.getByTestId('filter-operator-select')).getAllByRole('option').map(o => o.textContent)).toEqual(['below', 'at least', 'is']);
    expect(summarizeCondition(field, condition)).toBe('Software Version below Chrome 130');
  });
});
