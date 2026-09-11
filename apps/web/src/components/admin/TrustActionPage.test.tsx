import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

// Exercise the real runAction wrapper; the submit assertion and the AST guard
// together prevent this high-impact mutation from becoming a bare fetch.
import TrustActionPage from './TrustActionPage';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const preview = {
  valid: true as const,
  action: 'approve' as const,
  partner: {
    id: 'partner-1',
    name: 'Acme MSP',
    slug: 'acme-msp',
    plan: 'professional',
    trustState: 'probation',
  },
  card: {
    partner: {
      id: 'partner-1',
      name: 'Acme MSP',
      slug: 'acme-msp',
      plan: 'professional',
      status: 'active',
      trustState: 'probation',
    },
    signup: { ip: '203.0.113.10', ipClass: 'datacenter', asn: 64500 },
    emailDomain: { domain: 'acme.example', ageDays: null, hasMx: true },
    identity: {
      userName: 'Alex Admin',
      userEmail: 'alex@acme.example',
      cardholderName: 'Alice Buyer',
      namesMatch: false,
    },
    billing: { distinctPaymentMethods: 3, failedAttempts: 2, region: 'US-CO' },
    devices: [{
      hostname: 'ACME-LAPTOP',
      enrollmentIpClass: 'residential',
      isVirtual: false,
      enrollmentIp: '198.51.100.2',
    }],
    denials24h: 4,
    matchedSuspendedAxes: ['email_domain' as const, 'billing_card_fingerprint' as const],
  },
};

beforeEach(() => {
  window.history.replaceState({}, '', '/admin/trust/act?token=signed-token');
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('TrustActionPage', () => {
  it('renders the requested action and evidence-card summary', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse(preview));

    render(<TrustActionPage />);

    expect(await screen.findByRole('heading', { name: 'Approve partner' })).toBeTruthy();
    expect(screen.getByText('Acme MSP (acme-msp)')).toBeTruthy();
    expect(screen.getByText('professional')).toBeTruthy();
    expect(screen.getByText('probation')).toBeTruthy();
    expect(screen.getByText('datacenter')).toBeTruthy();
    expect(screen.getByText('64500')).toBeTruthy();
    expect(screen.getByText('Alex Admin')).toBeTruthy();
    expect(screen.getByText('Alice Buyer')).toBeTruthy();
    expect(screen.getByText('ACME-LAPTOP')).toBeTruthy();
    expect(screen.getByText('residential')).toBeTruthy();
    expect(screen.getByText('Email domain, Billing card fingerprint')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/trust/act/preview?token=signed-token');
  });

  it('submits the TOTP through runAction and shows the resulting trust state', async () => {
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/admin/trust/act/preview?token=signed-token') {
        return Promise.resolve(jsonResponse(preview));
      }
      if (url === '/admin/trust/act' && options?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, partnerId: 'partner-1', trustState: 'trusted' }));
      }
      throw new Error(`Unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });
    render(<TrustActionPage />);
    await screen.findByRole('heading', { name: 'Approve partner' });

    fireEvent.change(screen.getByLabelText('Six-digit TOTP code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve partner' }));

    const success = await screen.findByTestId('trust-action-success');
    expect(success.textContent).toContain('trusted');
    const mutation = fetchWithAuth.mock.calls.find(([url]) => url === '/admin/trust/act');
    expect(mutation).toBeTruthy();
    expect(mutation![1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse((mutation![1] as RequestInit).body as string)).toEqual({
      token: 'signed-token',
      totp: '123456',
    });
    expect(showToast).toHaveBeenCalledWith({ message: 'Trust action completed', type: 'success' });
  });

  it.each([
    ['expired', 'This link has expired'],
    ['used', 'This link was already used'],
    ['operator_mismatch', 'This link was issued to a different operator'],
    ['bad_signature', 'This link is not valid'],
  ] as const)('shows plain copy for an invalid %s token', async (reason, copy) => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ valid: false, reason }));

    render(<TrustActionPage />);

    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.queryByLabelText('Six-digit TOTP code')).toBeNull();
  });

  it('asks the operator to sign in when preview returns 401', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

    render(<TrustActionPage />);

    expect(await screen.findByText('Sign in as a platform admin to continue')).toBeTruthy();
  });

  it('labels a suspend action and accepts the suspension success body', async () => {
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      if (!options) return Promise.resolve(jsonResponse({ ...preview, action: 'suspend' }));
      return Promise.resolve(jsonResponse({ partnerId: 'partner-1', status: 'suspended' }));
    });
    render(<TrustActionPage />);
    await screen.findByRole('heading', { name: 'Suspend partner' });

    fireEvent.change(screen.getByLabelText('Six-digit TOTP code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend partner' }));

    await waitFor(() => expect(screen.getByTestId('trust-action-success').textContent).toContain('suspended'));
  });
});
