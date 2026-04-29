import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) =>
      selector({ login: vi.fn() }),
    {},
  ),
  apiRegisterPartner: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import PartnerRegisterPage from './PartnerRegisterPage';
import { apiRegisterPartner } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

const baseSuccess = {
  success: true as const,
  user: { id: 'u1', email: 'jane@acme.test', name: 'Jane', mfaEnabled: false },
  partner: { id: 'p1', name: 'Acme', slug: 'acme', status: 'active' },
  tokens: { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 900 },
};

async function fillAndSubmit() {
  fireEvent.input(screen.getByLabelText(/company name/i), { target: { value: 'Acme Co' } });
  fireEvent.input(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.input(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.test' } });
  fireEvent.input(screen.getAllByLabelText(/^password$/i)[0]!, { target: { value: 'Sup3rSecure!' } });
  fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'Sup3rSecure!' } });
  fireEvent.click(screen.getByLabelText(/I agree/i));
  fireEvent.click(screen.getByRole('button', { name: /create company account/i }));
}

describe('PartnerRegisterPage navigation after signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('billing-hook redirectUrl wins over next', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce({
      ...baseSuccess,
      redirectUrl: '/billing/onboarding',
    });
    render(<PartnerRegisterPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/billing/onboarding');
  });

  it('falls back to next when no redirectUrl is supplied', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    render(<PartnerRegisterPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });

  it('falls back to "/" when neither redirectUrl nor next is supplied', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    render(<PartnerRegisterPage />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });

  it('rewrites unsafe next to "/" before navigating', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    render(<PartnerRegisterPage next="//evil.example.com" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });
});
