import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import HashLink from './HashLink';
import {
  installAstroClientRouterStandIn,
  type ClientRouterStandIn,
} from '../../__tests__/astroClientRouterStandIn';

let router: ClientRouterStandIn;

beforeEach(() => {
  window.location.hash = '';
  router = installAstroClientRouterStandIn();
});

afterEach(() => {
  router.uninstall();
  window.location.hash = '';
});

/**
 * Collect hashchange events for the duration of one test. jsdom turns the
 * `location.hash = ''` reset in beforeEach into its own (async) hashchange, so
 * tests match on the destination rather than counting events.
 */
function recordHashChanges(): { urls: string[]; stop: () => void } {
  const urls: string[] = [];
  const listener = (e: Event) => urls.push((e as HashChangeEvent).newURL);
  window.addEventListener('hashchange', listener);
  return { urls, stop: () => window.removeEventListener('hashchange', listener) };
}

describe('HashLink (#4229)', () => {
  it('renders a real anchor so the fragment stays copyable and openable', () => {
    render(<HashLink hash="activities">View all activity</HashLink>);
    expect(screen.getByRole('link', { name: 'View all activity' })).toHaveAttribute(
      'href',
      '#activities'
    );
  });

  it('accepts a hash that already carries its "#" without doubling it', () => {
    render(<HashLink hash="#alerts">Alerts</HashLink>);
    expect(screen.getByRole('link', { name: 'Alerts' })).toHaveAttribute('href', '#alerts');
  });

  it('fires hashchange on a plain click even with Astro ClientRouter installed', async () => {
    const user = userEvent.setup();
    const hashChanges = recordHashChanges();

    render(<HashLink hash="activities">View all activity</HashLink>);
    await user.click(screen.getByRole('link', { name: 'View all activity' }));

    await waitFor(() =>
      expect(hashChanges.urls.some((u) => u.endsWith('#activities'))).toBe(true)
    );
    hashChanges.stop();
    expect(window.location.hash).toBe('#activities');
    // The whole point: the click reached the document already default-prevented,
    // so Astro's listener never swallowed it into a silent history.pushState.
    expect(router.observed).toHaveLength(1);
    expect(router.observed[0]?.defaultPrevented).toBe(true);
    expect(router.intercepted).toHaveLength(0);
  });

  it('navigates on keyboard activation, which is why this stays an anchor', async () => {
    const user = userEvent.setup();
    render(<HashLink hash="activities">View all activity</HashLink>);

    const link = screen.getByRole('link', { name: 'View all activity' });
    link.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(window.location.hash).toBe('#activities'));
    expect(router.intercepted).toHaveLength(0);
  });

  it('hands a cmd-click to the browser instead of navigating in place', async () => {
    const user = userEvent.setup();
    render(<HashLink hash="activities">View all activity</HashLink>);

    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('link', { name: 'View all activity' }));
    await user.keyboard('{/Meta}');

    // Left entirely to the browser: no preventDefault, so a real browser opens
    // the fragment in a new tab. (jsdom has no new-tab concept and just follows
    // the link, which is why this asserts the delegation, not the resulting URL.)
    expect(router.observed).toHaveLength(1);
    expect(router.observed[0]?.modified).toBe(true);
    expect(router.observed[0]?.defaultPrevented).toBe(false);
  });

  it('respects a caller onClick that prevents the default', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn((e: MouseEvent<HTMLAnchorElement>) => e.preventDefault());
    render(
      <HashLink hash="activities" onClick={onClick}>
        View all activity
      </HashLink>
    );

    await user.click(screen.getByRole('link', { name: 'View all activity' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });

  it('forwards presentational props to the anchor', () => {
    render(
      <HashLink hash="activities" className="text-primary" data-testid="view-all">
        View all activity
      </HashLink>
    );
    expect(screen.getByTestId('view-all')).toHaveClass('text-primary');
  });
});
