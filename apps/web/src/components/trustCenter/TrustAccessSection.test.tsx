// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@/lib/i18n';
const pageApi = vi.hoisted(() => ({ updateTrustPage: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => pageApi);
const api = vi.hoisted(() => ({
  listTrustAccessRequests: vi.fn(), approveTrustAccessRequest: vi.fn(), denyTrustAccessRequest: vi.fn(),
  revokeTrustAccessGrant: vi.fn(), resendTrustAccessGrant: vi.fn(),
}));
vi.mock('@/lib/api/trustPageAccess', () => api);
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast: toast }));
const emailFlag = vi.hoisted(() => ({ value: true as boolean | undefined }));
vi.mock('@/lib/useEmailConfigured', () => ({ useEmailConfigured: () => emailFlag.value }));
import TrustAccessSection from './TrustAccessSection';

const ok = () => new Response(JSON.stringify({ data: {} }), { status: 200 });
const fail = (status: number, code: string) => new Response(JSON.stringify({ error: 'x', code }), { status });
const orgFetch = vi.fn() as never;
const row = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, status, requesterEmail: `${id}@ins.test`, requesterName: `Name ${id}`, requesterCompany: 'Example Ins', purpose: 'Underwriting review',
  ndaAccepted: false, createdAt: '2026-10-17T10:00:00.000Z', emailVerifiedAt: null, decidedAt: null, decisionNote: null,
  grantExpiresAt: null, revokedAt: null, downloadCount: 0, lastDownloadedAt: null, grantedDocumentIds: [],
  expiresAt: null, expired: false, ...over,
});
const page = (over: Record<string, unknown> = {}) => ({ id: 'pg', publishedAt: '2026-10-10T00:00:00.000Z', publicationRevision: 5, ndaText: null, accessRequestCreatesTicket: false, ...over });
const gatedDoc = { documentId: 'd1', visibility: 'gated', disclosureConfirmedAt: '2026-10-01T00:00:00Z', sortOrder: 0, title: 'SOC 2', category: 'report', contentType: 'application/pdf', byteSize: 1, supersededByDocumentId: null, deleted: false };
const mount = (o: { canWrite?: boolean; page?: Record<string, unknown>; documents?: unknown[] } = {}) => {
  const onReload = vi.fn(async () => {});
  render(<TrustAccessSection orgId="o1" orgFetch={orgFetch} canWrite={o.canWrite ?? true} onReload={onReload}
    state={{ page: page(o.page), documents: o.documents ?? [gatedDoc] } as never} />);
  return onReload;
};

beforeEach(() => {
  vi.clearAllMocks();
  emailFlag.value = true;
  pageApi.updateTrustPage.mockResolvedValue(ok());
  api.listTrustAccessRequests.mockResolvedValue([row('r1', 'pending_approval'), row('r2', 'approved', { grantExpiresAt: '2026-10-24T00:00:00.000Z', expiresAt: '2026-10-24T00:00:00.000Z' })]);
  for (const fn of [api.approveTrustAccessRequest, api.denyTrustAccessRequest, api.revokeTrustAccessGrant, api.resendTrustAccessGrant]) fn.mockResolvedValue(ok());
});

describe('TrustAccessSection', () => {
  it('lists the requests with status, requester, company, purpose and expiry', async () => {
    mount();
    const r1 = await screen.findByTestId('trust-access-row-r1');
    expect(within(r1).getByText('Awaiting your decision')).toBeInTheDocument();
    expect(within(r1).getByText('Name r1')).toBeInTheDocument();
    expect(within(r1).getByText('Example Ins')).toBeInTheDocument();
    expect(within(r1).getByText('Underwriting review')).toBeInTheDocument();
    expect(screen.getByTestId('trust-access-row-r2')).toHaveTextContent('Approved');
  });

  it('Approve calls the API through runAction and reloads the list', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('trust-access-approve-r1'));
    await waitFor(() => expect(api.approveTrustAccessRequest).toHaveBeenCalledWith(orgFetch, 'o1', 'r1'));
    await waitFor(() => expect(api.listTrustAccessRequests).toHaveBeenCalledTimes(2));
  });

  it('Approve without MFA shows the MFA message (403 MFA_REQUIRED)', async () => {
    api.approveTrustAccessRequest.mockResolvedValueOnce(fail(403, 'MFA_REQUIRED'));
    mount();
    fireEvent.click(await screen.findByTestId('trust-access-approve-r1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/requires multi-factor authentication/) })));
    expect(api.listTrustAccessRequests).toHaveBeenCalledTimes(1);   // a refused approve does not reload
  });

  it('Deny asks for confirmation and sends the note', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('trust-access-deny-r1'));
    fireEvent.change(screen.getByTestId('trust-access-deny-note'), { target: { value: 'Please sign the NDA first' } });
    fireEvent.click(screen.getByTestId('trust-access-deny-confirm'));
    await waitFor(() => expect(api.denyTrustAccessRequest).toHaveBeenCalledWith(orgFetch, 'o1', 'r1', 'Please sign the NDA first'));
  });

  it('Revoke (confirmed) and Resend act on an approved grant', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('trust-access-revoke-r2'));
    fireEvent.click(screen.getByTestId('trust-access-revoke-confirm'));
    await waitFor(() => expect(api.revokeTrustAccessGrant).toHaveBeenCalledWith(orgFetch, 'o1', 'r2'));
    fireEvent.click(screen.getByTestId('trust-access-resend-r2'));
    await waitFor(() => expect(api.resendTrustAccessGrant).toHaveBeenCalledWith(orgFetch, 'o1', 'r2'));
  });

  it('read-only users see the table without actions or settings controls', async () => {
    mount({ canWrite: false });
    await screen.findByTestId('trust-access-row-r1');
    expect(screen.queryByTestId('trust-access-approve-r1')).toBeNull();
    expect(screen.queryByTestId('trust-access-revoke-r2')).toBeNull();
    expect(screen.getByTestId('trust-access-nda')).toBeDisabled();
    expect(screen.getByTestId('trust-access-save')).toBeDisabled();
  });

  it('saves the NDA text and ticket switch with the page revision', async () => {
    const onReload = mount();
    fireEvent.change(screen.getByTestId('trust-access-nda'), { target: { value: '  Keep it confidential.  ' } });
    fireEvent.click(screen.getByTestId('trust-access-ticket'));
    fireEvent.click(screen.getByTestId('trust-access-save'));
    await waitFor(() => expect(pageApi.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', {
      ndaText: 'Keep it confidential.', accessRequestCreatesTicket: true, expectedRevision: 5,
    }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('an emptied NDA saves as null', async () => {
    mount({ page: { ndaText: 'Old terms' } });
    fireEvent.change(screen.getByTestId('trust-access-nda'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('trust-access-save'));
    await waitFor(() => expect(pageApi.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', expect.objectContaining({ ndaText: null })));
  });

  it('shows "Requests open once the page is published" for an unpublished page with gated documents', async () => {
    mount({ page: { publishedAt: null } });
    expect(await screen.findByTestId('trust-access-unpublished')).toHaveTextContent('Requests open once the page is published');
  });

  it('hints how to accept requests when no document is gated', async () => {
    mount({ documents: [{ ...gatedDoc, visibility: 'public' }] });
    expect(await screen.findByTestId('trust-access-no-gated')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-access-unpublished')).toBeNull();
  });

  it('filters by status', async () => {
    mount();
    await screen.findByTestId('trust-access-row-r1');
    fireEvent.change(screen.getByTestId('trust-access-filter'), { target: { value: 'approved' } });
    await waitFor(() => expect(api.listTrustAccessRequests).toHaveBeenLastCalledWith(orgFetch, 'o1', 'approved'));
  });

  describe('no email transport (#9256)', () => {
    it('Approve says the requester was emailed when email is configured', async () => {
      mount();
      fireEvent.click(await screen.findByTestId('trust-access-approve-r1'));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/requester was emailed/) })));
    });

    it('Approve says the requester was NOT emailed when email is not configured', async () => {
      emailFlag.value = false;
      mount();
      fireEvent.click(await screen.findByTestId('trust-access-approve-r1'));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/No email service is configured.*not emailed/) })));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/was emailed/) }));
    });

    it('Approve keeps the default copy while the capability is unknown', async () => {
      emailFlag.value = undefined;
      mount();
      fireEvent.click(await screen.findByTestId('trust-access-approve-r1'));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/requester was emailed/) })));
    });

    it('Resend says a new link was emailed when configured', async () => {
      mount();
      fireEvent.click(await screen.findByTestId('trust-access-resend-r2'));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/new download link was emailed/) })));
    });

    it('Resend says it was NOT emailed when email is not configured', async () => {
      emailFlag.value = false;
      mount();
      fireEvent.click(await screen.findByTestId('trust-access-resend-r2'));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/No email service is configured.*not emailed/) })));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/was emailed/) }));
    });
  });
});
