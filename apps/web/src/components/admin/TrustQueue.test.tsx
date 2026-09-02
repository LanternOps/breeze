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

// Exercise the real runAction wrapper so these endpoint tests also verify
// operator-visible success feedback.
import TrustQueue from './TrustQueue';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const card = {
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
    cardholderName: 'Alex Admin',
    namesMatch: true,
  },
  billing: { distinctPaymentMethods: 1, failedAttempts: 2, region: 'US-CO' },
  devices: [{
    hostname: 'ACME-LAPTOP',
    enrollmentIpClass: 'residential',
    isVirtual: false,
    enrollmentIp: '198.51.100.2',
  }],
  denials24h: 3,
  matchedSuspendedAxes: ['email_domain'],
};

const row = {
  id: 'partner-1',
  name: 'Acme MSP',
  slug: 'acme-msp',
  plan: 'professional',
  status: 'active',
  trustState: 'probation',
  trustReason: 'New partner review',
  trustChangedAt: '2026-09-01T12:00:00Z',
  trustReviewRequestedAt: '2026-09-02T12:00:00Z',
  createdAt: '2026-08-30T12:00:00Z',
  signupIp: '203.0.113.10',
  signupIpClass: 'datacenter',
  signupIpAsn: 64500,
  deviceCount: 1,
  card,
};

function queueResponse(partners = [row], nextCursor: string | null = null) {
  return jsonResponse({ partners, nextCursor });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
  vi.restoreAllMocks();
});

describe('TrustQueue', () => {
  it('renders queue rows with the operator summary fields', async () => {
    fetchWithAuth.mockResolvedValue(queueResponse());

    render(<TrustQueue />);

    expect(await screen.findByText('Acme MSP')).toBeTruthy();
    expect(screen.getByText('professional')).toBeTruthy();
    expect(screen.getByText('probation')).toBeTruthy();
    expect(screen.getByText('New partner review')).toBeTruthy();
    expect(screen.getByText('datacenter')).toBeTruthy();
    expect(screen.getByText('ASN 64500')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/trust/queue?limit=50&card=1');
  });

  it('expands the preloaded evidence card inline', async () => {
    fetchWithAuth.mockResolvedValue(queueResponse());
    render(<TrustQueue />);
    await screen.findByText('Acme MSP');

    fireEvent.click(screen.getByTestId('trust-queue-expand-partner-1'));

    expect(screen.getByTestId('trust-queue-card-partner-1')).toBeTruthy();
    expect(screen.getAllByText('Alex Admin')).toHaveLength(2);
    expect(screen.getByText('ACME-LAPTOP')).toBeTruthy();
    expect(screen.getByText('Email domain')).toBeTruthy();
  });

  it.each([
    ['approve', 'Approve', '/admin/partners/partner-1/trust/promote', { reason: 'Reviewed and approved' }, 'Partner approved'],
    ['restrict', 'Restrict', '/admin/partners/partner-1/trust/restrict', { reason: 'Risk needs more review' }, 'Partner restricted'],
  ] as const)('runs the %s flow through the correct endpoint', async (_action, label, endpoint, expectedBody, toast) => {
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      if (!options) return Promise.resolve(queueResponse());
      if (url === endpoint && options.method === 'POST') return Promise.resolve(jsonResponse({ success: true }));
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    });
    vi.spyOn(window, 'prompt').mockReturnValue(expectedBody.reason);
    render(<TrustQueue />);
    await screen.findByText('Acme MSP');

    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => {
      const mutation = fetchWithAuth.mock.calls.find(([url]) => url === endpoint);
      expect(mutation).toBeTruthy();
      expect(JSON.parse((mutation![1] as RequestInit).body as string)).toEqual(expectedBody);
    });
    expect(showToast).toHaveBeenCalledWith({ message: toast, type: 'success' });
  });

  it('prompts for reason and confirmEmail before suspending', async () => {
    const endpoint = '/admin/partners/partner-1/suspend-for-abuse';
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      if (!options) return Promise.resolve(queueResponse());
      if (url === endpoint && options.method === 'POST') return Promise.resolve(jsonResponse({ success: true, status: 'suspended' }));
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    });
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('Confirmed abusive activity')
      .mockReturnValueOnce('operator@example.com');
    render(<TrustQueue />);
    await screen.findByText('Acme MSP');

    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));

    await waitFor(() => {
      const mutation = fetchWithAuth.mock.calls.find(([url]) => url === endpoint);
      expect(mutation).toBeTruthy();
      expect(JSON.parse((mutation![1] as RequestInit).body as string)).toEqual({
        reason: 'Confirmed abusive activity',
        confirmEmail: 'operator@example.com',
      });
    });
    expect(showToast).toHaveBeenCalledWith({ message: 'Partner suspended', type: 'success' });
  });

  it('loads the next cursor and appends rows', async () => {
    const secondRow = {
      ...row,
      id: 'partner-2',
      name: 'Beta IT',
      slug: 'beta-it',
      card: { ...card, partner: { ...card.partner, id: 'partner-2', name: 'Beta IT', slug: 'beta-it' } },
    };
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/admin/trust/queue?limit=50&card=1') return Promise.resolve(queueResponse([row], 'next/page'));
      if (url === '/admin/trust/queue?limit=50&card=1&cursor=next%2Fpage') return Promise.resolve(queueResponse([secondRow]));
      throw new Error(`Unexpected request: GET ${url}`);
    });
    render(<TrustQueue />);
    await screen.findByText('Acme MSP');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Beta IT')).toBeTruthy();
    expect(screen.getByText('Acme MSP')).toBeTruthy();
  });

  it('shows the platform-admin message for a 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ error: 'platform admin access required' }, 403));

    render(<TrustQueue />);

    expect(await screen.findByText('Sign in as a platform admin')).toBeTruthy();
  });
});
