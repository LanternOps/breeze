import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterSelect } from './FilterSelect';

describe('FilterSelect', () => {
  it('exposes an accessible name via a visually-hidden label bound with htmlFor', () => {
    render(
      <FilterSelect label="Severity" value="all" onChange={() => {}} data-testid="severity-filter">
        <option value="all">All severities</option>
        <option value="critical">Critical</option>
      </FilterSelect>
    );

    const select = screen.getByRole('combobox', { name: 'Severity' });
    expect(select).toBeTruthy();
    expect(select.tagName).toBe('SELECT');

    const label = document.querySelector(`label[for="${select.id}"]`);
    expect(label).toBeTruthy();
    expect(label?.className).toContain('sr-only');
  });

  it('forwards value, onChange and other select props', () => {
    const onChange = vi.fn();
    render(
      <FilterSelect label="Status" value="pending" onChange={onChange} className="sm:w-36">
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
      </FilterSelect>
    );

    const select = screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement;
    expect(select.value).toBe('pending');
    expect(select.className).toContain('sm:w-36');
  });
});
