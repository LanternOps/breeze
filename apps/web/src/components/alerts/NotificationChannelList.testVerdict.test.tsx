import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect } from 'vitest';
import NotificationChannelList, { type NotificationChannel } from './NotificationChannelList';

// A channel test that FAILED used to look exactly like one that passed: the
// text is the same string either way ("Last test: {{time}}") and the only
// difference was a 12px icon. An operator reads "Last test: Just Now" and
// concludes their on-call routing is verified when nothing was delivered.
//
// It was worse for assistive tech: lucide-react stamps aria-hidden="true" on
// any icon with no children and no aria-* / role / title prop, so the verdict
// was not in the accessibility tree at all. #3697.
//
// These assert the VISIBLE verdict rather than any particular markup, so a
// future redesign (a pill, a differently worded line) can satisfy them without
// being rewritten — the contract is "the outcome is stated", not "an <svg>
// carries an aria-label".
function channel(overrides: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: 'ch-1',
    name: 'QA Channel',
    type: 'email',
    enabled: true,
    config: {},
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
    ...overrides,
  };
}

describe('NotificationChannelList — last test verdict', () => {
  it('states that a failed test failed', () => {
    render(
      <NotificationChannelList
        channels={[channel({ lastTestStatus: 'failed', lastTestedAt: '2026-08-17T21:02:03.233Z' })]}
      />
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('Success')).toBeNull();
  });

  it('states that a passing test succeeded', () => {
    render(
      <NotificationChannelList
        channels={[channel({ lastTestStatus: 'success', lastTestedAt: '2026-08-17T21:02:03.233Z' })]}
      />
    );

    expect(screen.getByText('Success')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  // The defect itself: the two states must not render the same text. Comparing
  // full text content catches a regression that reverts the verdict to an
  // icon-only difference, which no single-string assertion would.
  it('does not render a failed test identically to a passing one', () => {
    const { container: passing, unmount } = render(
      <NotificationChannelList channels={[channel({ lastTestStatus: 'success' })]} />
    );
    const passingText = passing.textContent ?? '';
    unmount();

    const { container: failing } = render(
      <NotificationChannelList channels={[channel({ lastTestStatus: 'failed' })]} />
    );

    expect(failing.textContent).not.toEqual(passingText);
  });

  it('shows no verdict for a channel that was never tested', () => {
    render(<NotificationChannelList channels={[channel({})]} />);

    expect(screen.queryByText('Success')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByText('Never Tested')).toBeTruthy();
  });
});
