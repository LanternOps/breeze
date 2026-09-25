import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: authMocks.fetchWithAuth,
  useAuthStore: (selector: (s: { logout: () => void }) => unknown) =>
    selector({ logout: authMocks.logout }),
}));

import AccountInactiveScreen from './AccountInactiveScreen';

function mockPartnerMe(body: Record<string, unknown>) {
  authMocks.fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => body,
  });
}

describe('AccountInactiveScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the booking link next to the billing CTA for a pending partner', async () => {
    mockPartnerMe({
      status: 'pending',
      statusMessage: 'Pick a plan to activate your account.',
      statusActionUrl: 'https://billing.example.com/checkout',
      statusActionLabel: 'Choose a plan',
      statusMeetingUrl: 'https://calendly.example.com/breeze',
      statusMeetingLabel: null,
    });

    render(<AccountInactiveScreen />);

    const booking = await screen.findByRole('link', { name: 'Book a call with us' });
    expect(booking).toHaveAttribute('href', 'https://calendly.example.com/breeze');
    expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute(
      'href',
      'https://billing.example.com/checkout',
    );
  });

  it('still offers the booking link when the billing hook never supplied a CTA (stranded state)', async () => {
    mockPartnerMe({
      status: 'pending',
      statusMessage: null,
      statusActionUrl: null,
      statusActionLabel: null,
      statusMeetingUrl: 'https://calendly.example.com/breeze',
      statusMeetingLabel: 'Talk to Todd',
    });

    render(<AccountInactiveScreen />);

    expect(await screen.findByRole('link', { name: 'Talk to Todd' })).toHaveAttribute(
      'href',
      'https://calendly.example.com/breeze',
    );
  });

  it('does not show the booking link for suspended partners or unsafe URLs', async () => {
    mockPartnerMe({
      status: 'suspended',
      statusMessage: 'Suspended',
      statusActionUrl: null,
      statusActionLabel: null,
      statusMeetingUrl: 'https://calendly.example.com/breeze',
      statusMeetingLabel: null,
    });

    const { unmount } = render(<AccountInactiveScreen />);
    await waitFor(() => expect(authMocks.fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Book a call with us' })).toBeNull();
    unmount();

    mockPartnerMe({
      status: 'pending',
      statusMessage: null,
      statusActionUrl: null,
      statusActionLabel: null,
      statusMeetingUrl: 'javascript:alert(1)',
      statusMeetingLabel: null,
    });

    render(<AccountInactiveScreen />);
    await waitFor(() => expect(screen.queryByText('Almost There!')).not.toBeNull());
    expect(screen.queryByRole('link', { name: 'Book a call with us' })).toBeNull();
  });

  // #6627: a pending hosted partner whose role forces MFA got 428 on
  // GET /partner/me. The screen treated any non-OK answer as "no data" and sent
  // the user to `/`, where every protected call 403s PARTNER_INACTIVE straight
  // back here — an endless loop. A non-OK status must never mean "go home".
  describe('non-OK /partner/me (#6627 loop)', () => {
    const originalLocation = window.location;
    let hrefSets: string[];

    beforeEach(() => {
      hrefSets = [];
      const stub = { pathname: '/account/inactive', origin: 'http://localhost', search: '' } as Record<string, unknown>;
      Object.defineProperty(stub, 'href', {
        get: () => hrefSets[hrefSets.length - 1] ?? 'http://localhost/account/inactive',
        set: (v: string) => { hrefSets.push(v); },
      });
      Object.defineProperty(window, 'location', { configurable: true, value: stub });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    function mockPartnerMeStatus(status: number, body: Record<string, unknown>) {
      authMocks.fetchWithAuth.mockResolvedValue({
        ok: false,
        status,
        json: async () => body,
      });
    }

    it('sends a 428 mfa_enrollment_required to forced MFA setup, never to /', async () => {
      mockPartnerMeStatus(428, { error: 'mfa_enrollment_required' });

      render(<AccountInactiveScreen />);

      await waitFor(() => expect(hrefSets).toContain('/auth/mfa/setup?forced=1'));
      expect(hrefSets).not.toContain('/');
    });

    it('shows the load-failed state on a server error instead of bouncing to /', async () => {
      mockPartnerMeStatus(500, { error: 'boom' });

      render(<AccountInactiveScreen />);

      expect(await screen.findByText('Unable to load account status. Please try again later.')).not.toBeNull();
      expect(hrefSets).not.toContain('/');
    });

    it('still leaves the screen when the caller has no partner (404)', async () => {
      mockPartnerMeStatus(404, { error: 'No partner association' });

      render(<AccountInactiveScreen />);

      await waitFor(() => expect(hrefSets).toEqual(['/']));
    });
  });
});
