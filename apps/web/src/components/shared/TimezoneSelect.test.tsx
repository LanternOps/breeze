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

  it('warns when the stored zone is one the API will reject', () => {
    setup('Mars/Olympus_Mons');
    // Otherwise the only symptom is an unrelated edit failing to save with a
    // generic error, on a field the user never touched.
    expect(screen.getByTestId('tz-invalid')).toBeInTheDocument();
  });

  it('does NOT warn for a valid zone that Intl.supportedValuesOf simply omits', () => {
    // Etc/* and GMT are real IANA zones absent from the Intl list; flagging
    // them would be a false alarm on a value the API accepts.
    setup('Etc/GMT+5');
    expect(screen.queryByTestId('tz-invalid')).not.toBeInTheDocument();
    expect(screen.getByTestId('tz-trigger')).toHaveTextContent('Etc/GMT+5');
  });

  it('ArrowDown on the closed trigger opens the popover; Escape closes it', () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('tz-trigger'), { key: 'ArrowDown' });
    expect(screen.getByTestId('tz-popover')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Escape' });
    expect(screen.queryByTestId('tz-popover')).not.toBeInTheDocument();
  });

  it('moves focus into the search field on open, so the picker is keyboard-usable', () => {
    setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    expect(document.activeElement).toBe(screen.getByTestId('tz-search'));
  });

  it('closes on a click outside', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('tz-popover')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  // useClickOutside fires on mousedown, so the SAME physical click that
  // dismisses the popup can land on a Save button. Discarding an unambiguous
  // typed zone there would save the OLD value under a success toast — the
  // silent-wrong-value bug this component exists to remove.
  it('commits an unambiguous typed zone when dismissed by an outside click', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'europe/paris' } });
    fireEvent.mouseDown(document.body);

    expect(onChange).toHaveBeenCalledWith('Europe/Paris');
  });

  it('commits a filter that narrowed to a single row on an outside click', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    // Not an exact zone id, but only one zone can be meant.
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'reykjav' } });
    fireEvent.mouseDown(document.body);

    expect(onChange).toHaveBeenCalledWith('Atlantic/Reykjavik');
  });

  it('discards an AMBIGUOUS query on an outside click rather than guessing', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'europe/' } });
    fireEvent.mouseDown(document.body);

    // Many matches: clicking away genuinely means "changed my mind".
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tz-popover')).not.toBeInTheDocument();
  });

  // Regression: `active` once had two writers (a [query] reset effect plus the
  // open effect's seeding). Escaping out of a search left a stale query that
  // the open effect then cleared, firing the reset on the same commit and
  // clobbering the seeded index back to 0 — so Enter committed UTC over the
  // user's real zone, silently, in the component built to stop exactly that.
  it('Escape out of a search, reopen, Enter — re-commits the current zone, never UTC', () => {
    const onChange = setup('Europe/Paris');

    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'paris' } });
    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Escape' });

    fireEvent.click(screen.getByTestId('tz-trigger'));
    expect(screen.getByTestId('tz-search')).toHaveValue('');
    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalledWith('UTC');
    expect(onChange).toHaveBeenCalledWith('Europe/Paris');
  });

  it('announces the committed zone in the trigger name, as the native select did', () => {
    setup('America/New_York');
    // aria-label overrides name-from-content, so it has to carry the value or
    // the zone is invisible to assistive tech.
    expect(screen.getByTestId('tz-trigger')).toHaveAccessibleName('Timezone: America/New_York');
  });

  it('reopening clears the previous query and seeds the cursor on the committed zone', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TimezoneSelect value="UTC" onChange={onChange} label="Timezone" testId="tz" />,
    );

    fireEvent.click(screen.getByTestId('tz-trigger'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'paris' } });
    fireEvent.click(screen.getByTestId('tz-option-Europe/Paris'));

    // The parent commits the new value, as every consumer does.
    rerender(<TimezoneSelect value="Europe/Paris" onChange={onChange} label="Timezone" testId="tz" />);
    fireEvent.click(screen.getByTestId('tz-trigger'));

    // A stale query would leave the user staring at a mysteriously filtered list.
    expect(screen.getByTestId('tz-search')).toHaveValue('');
    // Enter without typing must re-commit the zone under the cursor, i.e. the
    // committed one — not whatever sits at index 0 (UTC).
    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Europe/Paris');
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
