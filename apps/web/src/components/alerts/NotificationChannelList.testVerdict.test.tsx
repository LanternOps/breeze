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

  // The reason (#3697, second half). "Failed" tells an operator their on-call
  // routing is broken; it does not tell them the recipient domain was rejected.
  // The provider message that says exactly that used to live only in a
  // five-second toast, so a reload lost it for good.
  describe('the failure reason', () => {
    const REASON =
      'Invalid `to` field. Please use our testing email address instead of domains like `example.com`.';

    it('shows why a failed test failed', () => {
      render(
        <NotificationChannelList
          channels={[channel({ lastTestStatus: 'failed', lastTestError: REASON })]}
        />
      );

      expect(screen.getByTestId('notification-channel-last-test-error').textContent).toContain(REASON);
    });

    // A green verdict must never sit above last week's error. The API NULLs the
    // column on a passing test; this is the client-side half of that contract,
    // so a stale field from a cached list cannot resurrect the old reason.
    it('shows no reason when the last test passed', () => {
      render(
        <NotificationChannelList
          channels={[channel({ lastTestStatus: 'success', lastTestError: REASON })]}
        />
      );

      expect(screen.queryByTestId('notification-channel-last-test-error')).toBeNull();
    });

    it('shows no reason for a channel that was never tested', () => {
      render(<NotificationChannelList channels={[channel({})]} />);

      expect(screen.queryByTestId('notification-channel-last-test-error')).toBeNull();
    });

    // #3992 caps a composed HTTP failure at 160 characters, but the column
    // still accepts up to MAX_CHANNEL_TEST_ERROR_LENGTH (500) for reasons that
    // never pass through that helper (a thrown Error.message, a provider SDK
    // string). The card clamps to two lines either way, so the full string has
    // to remain reachable — otherwise clamping silently recreates the
    // "operator cannot see what is wrong" defect.
    it('keeps the full reason reachable when the visible line is clamped', () => {
      const long = `HTTP 500: ${'diagnostic detail '.repeat(30)}`;

      render(
        <NotificationChannelList
          channels={[channel({ lastTestStatus: 'failed', lastTestError: long })]}
        />
      );

      expect(screen.getByTestId('notification-channel-last-test-error').getAttribute('title')).toBe(long);
    });
  });

  it('shows no verdict for a channel that was never tested', () => {
    render(<NotificationChannelList channels={[channel({})]} />);

    expect(screen.queryByText('Success')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByText('Never Tested')).toBeTruthy();
  });

  // The card's own relative-time strings were extracted into title-cased
  // labels that also dropped the `{{count}}` placeholder the caller passes, so
  // it read "Last test: Hours Ago" — wrong case, and no number at all. The
  // component now uses the shared `alerts:relativeTime.*` catalog, which is
  // correct in all eight locales (#3992).
  describe('relative timestamp', () => {
    it('states how long ago, with the count', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

      render(
        <NotificationChannelList
          channels={[channel({ lastTestStatus: 'success', lastTestedAt: threeHoursAgo })]}
        />
      );

      expect(screen.getByText('Last test: 3h ago')).toBeTruthy();
      expect(screen.queryByText(/Hours Ago/)).toBeNull();
    });

    it('is not title-cased for a just-now test', () => {
      render(
        <NotificationChannelList
          channels={[channel({ lastTestStatus: 'success', lastTestedAt: new Date().toISOString() })]}
        />
      );

      expect(screen.getByText('Last test: Just now')).toBeTruthy();
      expect(screen.queryByText(/Just Now/)).toBeNull();
    });
  });
});
