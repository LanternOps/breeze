import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { fetchWithAuth, runAction, showToast } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  runAction: vi.fn(async ({ request }: { request: () => Promise<Response> }) => { await request(); }),
  showToast: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));
vi.mock('../../lib/runAction', () => ({
  runAction,
  handleActionError: vi.fn(),
  ActionError: class ActionError extends Error {
    constructor(message: string, public status: number) { super(message); }
  },
}));
vi.mock('../shared/Toast', () => ({ showToast }));

import SendingDomainsAdmin from './SendingDomainsAdmin';

const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID, partnerId: 'p1', partnerName: 'Acme MSP', domain: 'mail.acme.test',
    provider: 'resend', status: 'verified', statusReason: null, providerManaged: true,
    verifiedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
    lastSendError: null, lastSendErrorAt: null,
    metrics: { windowDays: 7, messages: 1000, delivered: 900, bounced: 90, complained: 4, failed: 10, suppressed: 0, bounceRate: 0.09 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockResolvedValue(jsonResponse({ data: [row()] }));
});

describe('SendingDomainsAdmin', () => {
  it('renders one row per domain with the partner, the status and the 7-day metrics', async () => {
    render(<SendingDomainsAdmin />);
    const rowEl = await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    expect(within(rowEl).getByText('mail.acme.test')).toBeTruthy();
    expect(within(rowEl).getByText('Acme MSP')).toBeTruthy();
    expect(within(rowEl).getByTestId(`sending-domains-admin-bounce-rate-${DOMAIN_ID}`).textContent).toContain('9.00%');
    expect(within(rowEl).getByTestId(`sending-domains-admin-messages-${DOMAIN_ID}`).textContent).toContain('1,000');
    expect(within(rowEl).getByTestId(`sending-domains-admin-complaints-${DOMAIN_ID}`).textContent).toContain('4');
  });

  it('shows an unauthorized state instead of an empty table on 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({}, 403));
    render(<SendingDomainsAdmin />);
    expect(await screen.findByTestId('sending-domains-admin-requires-platform-admin')).toBeTruthy();
  });

  it('renders an explicit empty state', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ data: [] }));
    render(<SendingDomainsAdmin />);
    expect(await screen.findByTestId('sending-domains-admin-empty')).toBeTruthy();
  });

  it('suspends through runAction and reflects the new status', async () => {
    render(<SendingDomainsAdmin />);
    await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    fetchWithAuth.mockResolvedValue(jsonResponse({ success: true, status: 'suspended' }));
    fireEvent.click(screen.getByTestId(`sending-domains-admin-suspend-${DOMAIN_ID}`));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    expect(fetchWithAuth).toHaveBeenLastCalledWith(
      `/admin/sending-domains/${DOMAIN_ID}/suspend`,
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(
      screen.getByTestId(`sending-domains-admin-status-${DOMAIN_ID}`).textContent,
    ).toContain('suspended'));
  });

  it('unsuspends a suspended row', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ data: [row({ status: 'suspended', statusReason: 'abuse_auto' })] }));
    render(<SendingDomainsAdmin />);
    await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    fetchWithAuth.mockResolvedValue(jsonResponse({ success: true, status: 'pending' }));
    fireEvent.click(screen.getByTestId(`sending-domains-admin-unsuspend-${DOMAIN_ID}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith(
      `/admin/sending-domains/${DOMAIN_ID}/unsuspend`,
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  // Force-release drops Breeze's claim on a name and cannot be undone.
  it('confirms before force-releasing, and does nothing when the operator cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SendingDomainsAdmin />);
    await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    fireEvent.click(screen.getByTestId(`sending-domains-admin-force-release-${DOMAIN_ID}`));
    expect(runAction).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fetchWithAuth.mockResolvedValue(jsonResponse({ success: true }));
    fireEvent.click(screen.getByTestId(`sending-domains-admin-force-release-${DOMAIN_ID}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith(
      `/admin/sending-domains/${DOMAIN_ID}/force-release`,
      expect.objectContaining({ method: 'POST' }),
    ));
    confirmSpy.mockRestore();
  });

  it('shows the auto-suspension reason so the operator can tell it from a manual one', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ data: [row({ status: 'suspended', statusReason: 'abuse_auto' })] }));
    render(<SendingDomainsAdmin />);
    const rowEl = await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    expect(within(rowEl).getByTestId(`sending-domains-admin-status-${DOMAIN_ID}`).textContent).toContain('abuse_auto');
  });
});
