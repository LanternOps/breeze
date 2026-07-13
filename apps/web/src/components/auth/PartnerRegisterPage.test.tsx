import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  currentInstalledSession: vi.fn(() => true),
}));

vi.mock('../../stores/auth', () => ({
  apiRegisterPartner: vi.fn(),
  isInstalledAuthSessionCurrent: authMocks.currentInstalledSession,
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import PartnerRegisterPage from './PartnerRegisterPage';
import { apiRegisterPartner } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { useFeaturesStore } from '../../stores/featuresStore';

// The page now gates on the runtime registration flag (#1308). Seed the store
// to "loaded + enabled" so the form renders; the disabled path has its own test.
function setRegistration(enabled: boolean, loaded = true) {
  useFeaturesStore.setState({
    features: { billing: false, support: false },
    cfAccessLogin: { enabled: false },
    registration: { enabled },
    loaded,
  });
}

const baseSuccess = {
  success: true as const,
  user: { id: 'u1', email: 'jane@acme.test', name: 'Jane', mfaEnabled: false },
  partner: { id: 'p1', name: 'Acme', slug: 'acme', status: 'active' },
  tokens: { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 900 },
  installedSession: { generation: 1, userId: 'u1', accessToken: 'a' },
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
    authMocks.currentInstalledSession.mockReturnValue(true);
    setRegistration(true);
  });

  it('redirects to login when registration is disabled at runtime (#1308)', async () => {
    setRegistration(false);
    render(<PartnerRegisterPage />);
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith('/login?reason=registration-disabled'),
    );
    expect(screen.queryByLabelText(/company name/i)).toBeNull();
  });

  it('billing-hook redirectUrl wins over next', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce({
      ...baseSuccess,
      redirectUrl: '/billing/onboarding',
    });
    render(<PartnerRegisterPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/billing/onboarding', { guard: expect.any(Function) });
  });

  it('falls back to next when no redirectUrl is supplied', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    render(<PartnerRegisterPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc', { guard: expect.any(Function) });
  });

  it('falls back to "/" when neither redirectUrl nor next is supplied', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    render(<PartnerRegisterPage />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/', { guard: expect.any(Function) });
  });

  it('rewrites unsafe next to "/" before navigating', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    render(<PartnerRegisterPage next="//evil.example.com" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/', { guard: expect.any(Function) });
  });

  it('suppresses navigation when a newer session replaces the registered account', async () => {
    vi.mocked(apiRegisterPartner).mockResolvedValueOnce(baseSuccess);
    authMocks.currentInstalledSession.mockReturnValue(false);
    render(<PartnerRegisterPage />);

    await fillAndSubmit();

    await waitFor(() => expect(apiRegisterPartner).toHaveBeenCalledOnce());
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
