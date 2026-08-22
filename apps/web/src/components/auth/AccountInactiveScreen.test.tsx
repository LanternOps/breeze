import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
