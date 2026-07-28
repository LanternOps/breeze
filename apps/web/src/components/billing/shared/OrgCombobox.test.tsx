import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrgCombobox, orgComboboxOptions, type OrgComboboxOption } from './OrgCombobox';

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

    // The note is DESCRIBED to the focused search input, not just drawn beside
    // it — focus is in the search field, so an undescribed <p> reaches nobody.
    const search = screen.getByTestId('orgbox-search');
    expect(search).toHaveAttribute('aria-describedby', screen.getByTestId('orgbox-cap-note').id);

    // Narrowing below the cap removes the note.
    fireEvent.change(search, { target: { value: 'Acme' } });
    expect(screen.queryByTestId('orgbox-cap-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('orgbox-search')).not.toHaveAttribute('aria-describedby');
  });

  it('Enter and Space open the closed trigger, not just ArrowDown', () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('orgbox-trigger'), { key: 'Enter' });
    expect(screen.getByTestId('orgbox-popover')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('orgbox-search'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('orgbox-trigger'), { key: ' ' });
    expect(screen.getByTestId('orgbox-popover')).toBeInTheDocument();
  });

  it('reopening resets the query and the active index', () => {
    // A retained filter would show a partial list that looks like the whole
    // one, and a retained index would point Enter at a row the user can't see.
    const onSelect = setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    fireEvent.change(screen.getByTestId('orgbox-search'), { target: { value: 'zen' } });
    fireEvent.keyDown(screen.getByTestId('orgbox-search'), { key: 'Escape' });

    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    expect(screen.getByTestId('orgbox-search')).toHaveValue('');
    expect(screen.getByTestId('orgbox-list').querySelectorAll('[role="option"]')).toHaveLength(4);
    fireEvent.keyDown(screen.getByTestId('orgbox-search'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('org-1'); // top of the reset list
  });

  it('arrow navigation is audible: the combobox is the search input and activedescendant tracks the cursor', () => {
    // The failure this guards is silent, not visible — a bg-muted highlight
    // moves while AT announces nothing, and Enter then commits a customer
    // reassignment the user was never told about.
    setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    const search = screen.getByTestId('orgbox-search');

    // The combobox role belongs to the element that HOLDS FOCUS.
    expect(search).toHaveAttribute('role', 'combobox');
    expect(screen.getByTestId('orgbox-trigger')).not.toHaveAttribute('role', 'combobox');

    const optionAt = (i: number) => screen.getByTestId('orgbox-list').querySelectorAll('[role="option"]')[i];
    expect(search).toHaveAttribute('aria-activedescendant', optionAt(0)!.id);
    expect(optionAt(0)).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', optionAt(1)!.id);
    // aria-selected follows the CURSOR, not the committed value (org-1).
    expect(optionAt(1)).toHaveAttribute('aria-selected', 'true');
    expect(optionAt(0)).toHaveAttribute('aria-selected', 'false');
  });

  it('does not point aria-controls at a list that is not rendered', () => {
    setup();
    fireEvent.click(screen.getByTestId('orgbox-trigger'));
    const search = screen.getByTestId('orgbox-search');
    expect(search).toHaveAttribute('aria-controls', screen.getByTestId('orgbox-list').id);

    fireEvent.change(search, { target: { value: 'nomatch' } });
    expect(screen.queryByTestId('orgbox-list')).not.toBeInTheDocument();
    expect(search).not.toHaveAttribute('aria-controls');
    expect(search).not.toHaveAttribute('aria-activedescendant');
  });

  it('renders the raw id rather than a blank when value is not in options', () => {
    // Loud beats empty: a blank trigger is indistinguishable from "no customer
    // selected" on a money document.
    render(<OrgCombobox options={orgs} value="org-missing" onSelect={vi.fn()} label="Customer" testId="orphan" />);
    expect(screen.getByTestId('orphan-trigger')).toHaveTextContent('org-missing');
  });
});

describe('orgComboboxOptions', () => {
  it('sorts by name and leaves a present selection alone', () => {
    const out = orgComboboxOptions([{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Acme' }], 'a', 'ignored');
    expect(out.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('prepends a missing selection so `value ∈ options` always holds', () => {
    // The All-orgs / cross-partner case: the store never loaded this org, and
    // without the prepend the trigger has nothing to render.
    const out = orgComboboxOptions([{ id: 'b', name: 'Beta' }], 'ghost', 'Ghost Co');
    expect(out[0]).toEqual({ id: 'ghost', name: 'Ghost Co' });
    expect(out.some((o) => o.id === 'ghost')).toBe(true);
  });

  it('narrows to {id, name} so callers need no cast to satisfy the option type', () => {
    // Both call sites previously hand-rolled this and ended in an `as` cast
    // fabricating a partial Organization. Mapping down is what removes it.
    const out = orgComboboxOptions([{ id: 'a', name: 'Acme', extra: 'dropped' } as never], 'a', 'x');
    expect(Object.keys(out[0]!).sort()).toEqual(['id', 'name']);
  });
});
