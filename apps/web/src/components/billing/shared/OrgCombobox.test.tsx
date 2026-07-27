import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrgCombobox, type OrgComboboxOption } from './OrgCombobox';

// The dangerous surface here is index-based selection under filtering: Enter
// picks results[active], so if the active index ever stops resetting on a
// query change, a typed filter + Enter would select a stale index into a
// DIFFERENT list — and both consumers (customer reassignment, clone target)
// turn that into a quote pointed at the wrong company.

const orgs: OrgComboboxOption[] = [
  { id: 'org-1', name: 'Acme' },
  { id: 'org-2', name: 'Beta Corp' },
  { id: 'org-3', name: 'Beta Industries' },
  { id: 'org-4', name: 'Zenith' },
];

function setup(options: OrgComboboxOption[] = orgs) {
  const onSelect = vi.fn();
  render(<OrgCombobox options={options} value="org-1" onSelect={onSelect} label="Customer" testId="orgbox" />);
  return onSelect;
}

describe('OrgCombobox', () => {
  it('opens on trigger click showing the current selection, and picks by click', () => {
    const onSelect = setup();
    expect(screen.getByTestId('orgbox-trigger')).toHaveTextContent('Acme');

    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    fireEvent.click(screen.getByTestId('orgbox-option-org-4'));

    expect(onSelect).toHaveBeenCalledWith('org-4');
    expect(screen.queryByTestId('orgbox-popover')).not.toBeInTheDocument();
  });

  it('ArrowDown on the closed trigger opens the popover', () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('orgbox-trigger'), { key: 'ArrowDown' });
    expect(screen.getByTestId('orgbox-popover')).toBeInTheDocument();
  });

  it('typing a filter then Enter selects the TOP VISIBLE match, not a stale index', () => {
    const onSelect = setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    const search = screen.getByTestId('orgbox-search');

    // Move the active index down in the unfiltered list first, THEN filter —
    // the index must reset to the filtered list's top.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.change(search, { target: { value: 'zen' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('org-4');
  });

  it('ArrowDown navigates the filtered list and Enter picks the highlighted option', () => {
    const onSelect = setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    const search = screen.getByTestId('orgbox-search');

    fireEvent.change(search, { target: { value: 'beta' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('org-3');
  });

  it('Escape closes without selecting and returns focus to the trigger', () => {
    const onSelect = setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    fireEvent.keyDown(screen.getByTestId('orgbox-search'), { key: 'Escape' });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('orgbox-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('orgbox-trigger')).toHaveFocus();
  });

  it('a filter with no matches shows the no-results message and Enter selects nothing', () => {
    const onSelect = setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    const search = screen.getByTestId('orgbox-search');

    fireEvent.change(search, { target: { value: 'nomatch' } });
    expect(screen.getByTestId('orgbox-noresults')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('announces truncation past 50 results instead of silently dropping orgs', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `o-${i}`, name: `Org ${String(i).padStart(2, '0')}` }));
    const onSelect = vi.fn();
    render(<OrgCombobox options={[{ id: 'org-1', name: 'Acme' }, ...many]} value="org-1" onSelect={onSelect} label="Customer" testId="orgbox" />);

    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    // An org past position 50 must not read as "not a valid target".
    expect(screen.getByTestId('orgbox-cap-note')).toBeInTheDocument();
    expect(screen.getByTestId('orgbox-list').querySelectorAll('[role="option"]')).toHaveLength(50);

    // Narrowing below the cap removes the note.
    fireEvent.change(screen.getByTestId('orgbox-search'), { target: { value: 'Acme' } });
    expect(screen.queryByTestId('orgbox-cap-note')).not.toBeInTheDocument();
  });
});
