import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/stores/auth';
import { TRUST_DENIED_EVENT, type TrustDenial } from '@/lib/trustProbation';
import TrustProbationBanner from './TrustProbationBanner';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const status = {
  trustState: 'probation',
  checklist: {
    ageOk: true,
    emailVerified: true,
    cardSettled: false,
    signupIpOk: false,
  },
  reviewRequestedAt: null,
  meetingUrl: 'https://meet.example.test/trust',
};

function response(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deny(overrides: Partial<TrustDenial> = {}): TrustDenial {
  return {
    error: 'TRUST_PROBATION',
    capability: 'remote_control',
    reason: 'probation_default_deny',
    reviewRequested: false,
    meetingUrl: null,
    ...overrides,
  };
}

function dispatch(detail: TrustDenial) {
  window.dispatchEvent(new CustomEvent(TRUST_DENIED_EVENT, { detail }));
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

describe('TrustProbationBanner', () => {
  it('renders denial-specific copy, checklist ticks, and the meeting link', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(response(status));
    render(<TrustProbationBanner />);

    dispatch(deny({ capability: 'device_execute' }));

    expect(await screen.findByText('Verification pending')).toBeInTheDocument();
    expect(screen.getByText('Script execution is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Remote control and script execution unlock/)).toBeInTheDocument();
    const checklist = await screen.findByRole('list', { name: 'Verification checklist' });
    expect(within(checklist).getByText('24 hours since signup').parentElement).toHaveTextContent('complete');
    expect(within(checklist).getByText('Card payment settled').parentElement).toHaveTextContent('pending');
    expect(screen.getByRole('link', { name: 'Book a call' })).toHaveAttribute(
      'href',
      status.meetingUrl,
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/partner/trust');
  });

  it('renders the restricted title', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(response({ ...status, trustState: 'restricted' }));
    render(<TrustProbationBanner />);
    dispatch(deny({ error: 'TRUST_RESTRICTED', capability: 'installer_distribute' }));

    expect(await screen.findByText('Account restricted')).toBeInTheDocument();
    expect(screen.getByText('Installer distribution is temporarily unavailable.')).toBeInTheDocument();
  });

  it('requests a review through runAction and flips the button after success', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ requested: true }));
    render(<TrustProbationBanner />);
    dispatch(deny());

    fireEvent.click(await screen.findByRole('button', { name: 'Request review' }));

    expect(await screen.findByRole('button', { name: 'Review requested' })).toBeDisabled();
    expect(fetchWithAuthMock).toHaveBeenLastCalledWith('/partner/trust/request-review', { method: 'POST' });
  });

  it('treats a 429 as an already-requested review', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ error: 'trust review was requested within the last 24 hours' }, 429));
    render(<TrustProbationBanner />);
    dispatch(deny());

    fireEvent.click(await screen.findByRole('button', { name: 'Request review' }));

    expect(await screen.findByRole('button', { name: 'Review requested' })).toBeDisabled();
  });

  it('dismisses and re-shows on the next denial', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response(status));
    render(<TrustProbationBanner />);
    dispatch(deny());

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss verification notice' }));
    expect(screen.queryByTestId('trust-probation-banner')).not.toBeInTheDocument();

    dispatch(deny({ capability: 'agent_enroll' }));
    expect(await screen.findByTestId('trust-probation-banner')).toBeInTheDocument();
    expect(screen.getByText('Agent enrollment is temporarily unavailable.')).toBeInTheDocument();
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
  });
});
