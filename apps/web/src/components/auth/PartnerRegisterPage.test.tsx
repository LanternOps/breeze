import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stable spy so `expect(mockLogin).not.toHaveBeenCalled()` is meaningful — the
// selector must hand back the SAME login fn on every render, not a fresh one.
const { mockLogin } = vi.hoisted(() => ({ mockLogin: vi.fn() }));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) =>
      selector({ login: mockLogin }),
    {},
  ),
  apiRegisterPartner: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import PartnerRegisterPage from './PartnerRegisterPage';
import { apiRegisterPartner } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { useFeaturesStore } from '../../stores/featuresStore';

const mockApiRegisterPartner = vi.mocked(apiRegisterPartner);
const mockNavigateTo = vi.mocked(navigateTo);

// The page gates on the runtime registration flag (#1308). Seed the store to
// "loaded + enabled" so the form renders; the disabled path has its own test.
function setRegistration(enabled: boolean, loaded = true) {
  useFeaturesStore.setState({
    features: { billing: false, support: false },
    cfAccessLogin: { enabled: false },
    registration: { enabled },
    loaded,
  });
}

async function submitValidForm() {
  fireEvent.input(screen.getByLabelText(/company name/i), { target: { value: 'Acme Co' } });
  fireEvent.input(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.input(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.test' } });
  fireEvent.input(screen.getAllByLabelText(/^password$/i)[0]!, { target: { value: 'Sup3rSecure!' } });
  fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'Sup3rSecure!' } });
  fireEvent.click(screen.getByLabelText(/I agree/i));
  fireEvent.click(screen.getByRole('button', { name: /create company account/i }));
}

describe('PartnerRegisterPage — SR2-21 email-first signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('SR2-21: a successful signup shows "check your email" and does NOT log the user in', async () => {
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'If registration can proceed…' });
    render(<PartnerRegisterPage />);
    await submitValidForm();
    expect(await screen.findByTestId('register-check-email')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockNavigateTo).not.toHaveBeenCalled();
  });

  it('shows the same "check your email" panel for an address that already has an account', async () => {
    // Same server response — the UI must not branch on it either (anti-enumeration).
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'If registration can proceed…' });
    render(<PartnerRegisterPage />);
    await submitValidForm();
    expect(await screen.findByTestId('register-check-email')).toBeInTheDocument();
  });
});
