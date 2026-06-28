import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SearchableSelect, { type SelectOption } from './SearchableSelect';

const OPTIONS: SelectOption[] = [
  { id: 'org-1', name: 'Acme Corp' },
  { id: 'org-2', name: 'Globex' },
  { id: 'org-3', name: 'Initech' },
];

function setup(value = '') {
  const onChange = vi.fn();
  render(<SearchableSelect options={OPTIONS} value={value} onChange={onChange} testId="ss" />);
  return { onChange, input: screen.getByTestId('ss-input') as HTMLInputElement };
}

describe('SearchableSelect', () => {
  it('opens on focus and filters by name substring', () => {
    const { input } = setup();
    fireEvent.focus(input);
    expect(screen.getByTestId('ss-list')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'glo' } });
    expect(screen.getByTestId('ss-option-org-2')).toBeInTheDocument();
    expect(screen.queryByTestId('ss-option-org-1')).not.toBeInTheDocument();
  });

  it('selects an option on click and reports its id', () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.click(screen.getByTestId('ss-option-org-3'));
    expect(onChange).toHaveBeenCalledWith('org-3');
    // List closes after a pick.
    expect(screen.queryByTestId('ss-list')).not.toBeInTheDocument();
  });

  it('supports keyboard navigation (ArrowDown + Enter)', () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    // active starts at 0 (Acme); one ArrowDown moves to Globex.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('org-2');
  });

  it('shows a "Showing N of M" hint when matches exceed the cap', () => {
    const many: SelectOption[] = Array.from({ length: 12 }, (_, i) => ({ id: `o-${i}`, name: `Org ${i}` }));
    const onChange = vi.fn();
    render(<SearchableSelect options={many} value="" onChange={onChange} testId="ss" maxResults={8} />);
    fireEvent.focus(screen.getByTestId('ss-input'));
    expect(screen.getByTestId('ss-truncated')).toHaveTextContent('Showing 8 of 12');
  });

  it('shows a no-matches hint when the query matches nothing', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByTestId('ss-noresults')).toBeInTheDocument();
  });

  it('displays the selected option name when closed', () => {
    const { input } = setup('org-1');
    expect(input.value).toBe('Acme Corp');
  });

  it('points aria-activedescendant at the highlighted option for screen readers', () => {
    const { input } = setup();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.focus(input);
    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    // The id must resolve to a rendered option element.
    expect(document.getElementById(active as string)).toHaveAttribute('role', 'option');
  });
});
