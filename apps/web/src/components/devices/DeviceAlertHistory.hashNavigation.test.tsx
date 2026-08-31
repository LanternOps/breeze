/**
 * #4229 — the third in-page hash link converted to `HashLink`.
 *
 * `DeviceAlertHistory`'s "View all N alerts" link only renders when a caller
 * passes `limit`, and the sole production caller (DeviceDetails' Alerts tab)
 * does not — so this link is currently unreachable in the product. It carried
 * the identical ClientRouter defect as the two reachable links, and this suite
 * pins the fixed behaviour before the branch becomes reachable again (e.g. an
 * Overview alert-preview card).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceAlertHistory from './DeviceAlertHistory';
import {
  installAstroClientRouterStandIn,
  type ClientRouterStandIn,
} from '../../__tests__/astroClientRouterStandIn';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const alert = (id: string) => ({
  id,
  severity: 'warning',
  message: `Alert ${id}`,
  status: 'active',
  createdAt: '2026-02-09T09:00:00.000Z',
});

let router: ClientRouterStandIn;

beforeEach(() => {
  window.location.hash = '';
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [alert('a1'), alert('a2'), alert('a3')] }),
  } as unknown as Response);
  router = installAstroClientRouterStandIn();
});

afterEach(() => {
  router.uninstall();
  window.location.hash = '';
});

describe('DeviceAlertHistory "View all N alerts" hash link (#4229)', () => {
  it('moves the fragment to #alerts on click instead of leaving it to Astro', async () => {
    const user = userEvent.setup();
    render(<DeviceAlertHistory deviceId="device-1" limit={2} />);

    const link = await screen.findByRole('link', { name: /View all 3 alerts/i });
    expect(link).toHaveAttribute('href', '#alerts');

    await user.click(link);

    await waitFor(() => expect(window.location.hash).toBe('#alerts'));
    // Astro's router never saw an un-prevented click, so the fragment moved
    // through a real hashchange rather than a silent history.pushState.
    expect(router.observed).toHaveLength(1);
    expect(router.observed[0]?.defaultPrevented).toBe(true);
    expect(router.intercepted).toHaveLength(0);
  });
});
