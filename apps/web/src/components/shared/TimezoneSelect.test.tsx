import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import TimezoneSelect from './TimezoneSelect';

// The regression this component exists for (issue #2856): the org/site creation
// timezone picker was a 10-entry hardcoded list with no Europe/Paris, so a
// French self-hoster could not select their own zone at all. The tests below
// pin the two properties that has to keep holding — every IANA zone is
// reachable, and a stored zone outside any curated list still renders.

function setup(value = 'UTC') {
  const onChange = vi.fn();
  render(
    <TimezoneSelect value={value} onChange={onChange} label="Timezone" testId="tz" />,
  );
  return onChange;
}

describe('TimezoneSelect', () => {
  it('offers Europe/Paris and selects it by click (issue #2856)', () => {
    const onChange = setup();

    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.click(screen.getByTestId('tz-option-Europe/Paris'));

    expect(onChange).toHaveBeenCalledWith('Europe/Paris');
    expect(screen.queryByTestId('tz-popover')).not.toBeInTheDocument();
  });

  it('renders the full IANA list rather than a truncated slice', () => {
    setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));

    const options = screen.getByTestId('tz-list').querySelectorAll('[role="option"]');
    // A cap would silently hide zones late in the alphabet — the exact failure
    // mode being fixed. Assert on a zone that sorts near the end, not a count.
    expect(options.length).toBeGreaterThan(300);
    expect(screen.getByTestId('tz-option-Pacific/Auckland')).toBeInTheDocument();
  });

  it('filters case-insensitively on the city, treating underscores as spaces', () => {
    setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'new york' } });

    expect(screen.getByTestId('tz-option-America/New_York')).toBeInTheDocument();
    expect(screen.queryByTestId('tz-option-Europe/Paris')).not.toBeInTheDocument();
  });

  it('typing a filter then Enter selects the top visible match, not a stale index', () => {
    const onChange = setup('Australia/Sydney');
    fireEvent.click(screen.getByTestId('tz-trigger'));
    // Opening seeds `active` with the committed zone's index (deep in the list);
    // a filter that does not reset it would commit an unrelated zone on Enter.
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'paris' } });
    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('Europe/Paris');
  });

  it('shows a no-results message instead of an empty listbox', () => {
    setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'zzzz' } });

    expect(screen.getByTestId('tz-noresults')).toBeInTheDocument();
    expect(screen.queryByTestId('tz-list')).not.toBeInTheDocument();
    // A dangling aria-controls on an expanded combobox is worse than none.
    expect(screen.getByTestId('tz-search')).not.toHaveAttribute('aria-controls');
  });

  it('keeps a stored zone outside the Intl list visible and selectable', () => {
    setup('Mars/Olympus_Mons');

    expect(screen.getByTestId('tz-trigger')).toHaveTextContent('Mars/Olympus_Mons');
    fireEvent.click(screen.getByTestId('tz-trigger'));
    expect(screen.getByTestId('tz-option-Mars/Olympus_Mons')).toBeInTheDocument();
    // An unformattable zone must not blank the control: it just gets no offset.
    expect(screen.getByTestId('tz-list')).toBeInTheDocument();
  });

  it('ArrowDown on the closed trigger opens the popover; Escape closes it', () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('tz-trigger'), { key: 'ArrowDown' });
    expect(screen.getByTestId('tz-popover')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Escape' });
    expect(screen.queryByTestId('tz-popover')).not.toBeInTheDocument();
  });

  it('tracks the keyboard cursor with aria-activedescendant', () => {
    setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    // 'europe/p' keeps several matches, so ArrowDown has somewhere to move.
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'europe/p' } });

    const search = screen.getByTestId('tz-search');
    const firstOptionId = screen
      .getByTestId('tz-list')
      .querySelector('[role="option"]')
      ?.getAttribute('id');
    expect(search.getAttribute('aria-activedescendant')).toBe(firstOptionId);

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).not.toBe(firstOptionId);
  });
});
