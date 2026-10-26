import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const api = vi.hoisted(() => ({
  listAgreementRequests: vi.fn(),
  getAgreementRequestLink: vi.fn(),
  voidAgreementRequest: vi.fn(),
  deleteAgreementRequest: vi.fn(),
}));
vi.mock('../../lib/api/agreementRequests', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/agreementRequests')>();
  return { ...orig, ...api };
});

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => perms.granted.has(`${r}:${a}`) }),
}));

import AgreementRequestsTable from './AgreementRequestsTable';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', orgId: 'org-1', status: 'sent', templateId: 't1', templateVersionId: 'v1', contractId: null,
  label: 'Renewal 2027', coverMessage: null, variableValues: {}, expiresAt: '2026-12-01T00:00:00Z',
  sentAt: '2026-11-01T00:00:00Z', firstViewedAt: null, signedAt: null, declinedAt: null, voidedAt: null,
  expiredAt: null, declineReason: null, voidReason: null, reminderCount: 0, createdAt: '2026-11-01T00:00:00Z',
  templateName: 'MSA', templateVersionNumber: 3, signedAgreementId: null, recipients: ['a@acme.test'], ...over,
});

describe('AgreementRequestsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    perms.granted = new Set(['agreements:read', 'agreements:write', 'agreements:send']);
    api.listAgreementRequests.mockResolvedValue(resp({ data: [row()] }));
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('loads the bucket with the locked filters and renders template, label, org and localized status', async () => {
    render(<AgreementRequestsTable bucket="pending" lockedContractId="ct-1" orgNames={{ 'org-1': 'Acme' }} />);
    const rows = await screen.findAllByTestId('agreement-request-row');
    expect(api.listAgreementRequests).toHaveBeenCalledWith({ status: 'pending', orgId: undefined, contractId: 'ct-1' });
    expect(rows[0]).toHaveAttribute('data-request-id', 'r1');
    expect(within(rows[0]).getByText(/MSA/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('Renewal 2027')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Acme')).toBeInTheDocument();
    expect(within(rows[0]).getByTestId('agreement-request-status')).toHaveTextContent('Awaiting signature');
  });

  it('hides the organization column when the org is locked', async () => {
    render(<AgreementRequestsTable bucket="pending" lockedOrgId="org-1" orgNames={{}} />);
    await screen.findAllByTestId('agreement-request-row');
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
  });

  it('copy link fetches the link and writes it to the clipboard', async () => {
    api.getAgreementRequestLink.mockResolvedValue(resp({ data: { link: 'https://app.test/sign/abc', reissued: false } }));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-copy-link-r1'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app.test/sign/abc'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Signing link copied' }));
  });

  it('copy link toasts an error (never silent) when the link request fails', async () => {
    api.getAgreementRequestLink.mockResolvedValue(resp({ error: 'Not sent' }, 409));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-copy-link-r1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copy link toasts an error when the clipboard write is refused', async () => {
    api.getAgreementRequestLink.mockResolvedValue(resp({ data: { link: 'https://x/y', reissued: true } }));
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-copy-link-r1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('void opens a confirm dialog, posts the reason and reloads', async () => {
    api.voidAgreementRequest.mockResolvedValue(resp({ data: row({ status: 'voided' }) }));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-void-r1'));
    await screen.findByTestId('agreement-request-void-dialog');
    fireEvent.change(screen.getByTestId('agreement-request-void-reason'), { target: { value: 'Wrong template' } });
    fireEvent.click(screen.getByTestId('agreement-request-void-confirm'));
    await waitFor(() => expect(api.voidAgreementRequest).toHaveBeenCalledWith('r1', 'Wrong template'));
    await waitFor(() => expect(api.listAgreementRequests).toHaveBeenCalledTimes(2));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('draft rows offer Delete draft (not copy link / void) and delete via the API', async () => {
    api.listAgreementRequests.mockResolvedValue(resp({ data: [row({ status: 'draft', sentAt: null })] }));
    api.deleteAgreementRequest.mockResolvedValue(resp({ data: { id: 'r1' } }));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    await screen.findByTestId('agreement-request-delete-r1');
    expect(screen.queryByTestId('agreement-request-copy-link-r1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agreement-request-void-r1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agreement-request-delete-r1'));
    await waitFor(() => expect(api.deleteAgreementRequest).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(api.listAgreementRequests).toHaveBeenCalledTimes(2));
  });

  it('gates actions on permissions: delete draft needs write, copy/void need send', async () => {
    perms.granted = new Set(['agreements:read']);
    api.listAgreementRequests.mockResolvedValue(resp({ data: [row(), row({ id: 'r2', status: 'draft' })] }));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    await screen.findAllByTestId('agreement-request-row');
    expect(screen.queryByTestId('agreement-request-copy-link-r1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agreement-request-void-r1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agreement-request-delete-r2')).not.toBeInTheDocument();
  });

  it('never renders a Remind button', async () => {
    api.listAgreementRequests.mockResolvedValue(resp({ data: [row(), row({ id: 'r2', status: 'viewed' }), row({ id: 'r3', status: 'draft' })] }));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    await screen.findAllByTestId('agreement-request-row');
    expect(screen.queryByText(/remind/i)).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid*="remind"]')).toBeNull();
  });

  it('closed rows have no actions and show the decline / void reason', async () => {
    api.listAgreementRequests.mockResolvedValue(resp({
      data: [row({ id: 'c1', status: 'declined', declineReason: 'Too expensive' }), row({ id: 'c2', status: 'voided', voidReason: 'Wrong org' })],
    }));
    render(<AgreementRequestsTable bucket="closed" orgNames={{}} />);
    const rows = await screen.findAllByTestId('agreement-request-row');
    expect(rows[0]).toHaveTextContent('Declined: Too expensive');
    expect(rows[1]).toHaveTextContent('Voided: Wrong org');
    expect(rows[0].querySelectorAll('button')).toHaveLength(0);
    expect(rows[1].querySelectorAll('button')).toHaveLength(0);
  });

  it('shows a per-view empty state and a load error', async () => {
    api.listAgreementRequests.mockResolvedValue(resp({ data: [] }));
    const { unmount } = render(<AgreementRequestsTable bucket="closed" orgNames={{}} />);
    expect(await screen.findByTestId('agreement-requests-empty')).toHaveTextContent(/No declined, voided or expired/);
    unmount();
    api.listAgreementRequests.mockResolvedValue(resp({ error: 'boom' }, 500));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    expect(await screen.findByTestId('agreement-requests-error')).toBeInTheDocument();
  });
  it('clipboard failure shows a clipboardError toast that includes the signing link', async () => {
    api.getAgreementRequestLink.mockResolvedValue(resp({ data: { link: 'https://app.test/sign/xyz', reissued: false } }));
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-copy-link-r1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining('https://app.test/sign/xyz'),
    })));
  });

  it('a failed void keeps the dialog open and the typed reason, and does not reload', async () => {
    api.voidAgreementRequest.mockResolvedValue(resp({ error: 'Already signed' }, 409));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-void-r1'));
    await screen.findByTestId('agreement-request-void-dialog');
    fireEvent.change(screen.getByTestId('agreement-request-void-reason'), { target: { value: 'Wrong template' } });
    fireEvent.click(screen.getByTestId('agreement-request-void-confirm'));
    await waitFor(() => expect(api.voidAgreementRequest).toHaveBeenCalled());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(screen.getByTestId('agreement-request-void-confirm')).toBeEnabled());
    expect(screen.getByTestId('agreement-request-void-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('agreement-request-void-reason')).toHaveValue('Wrong template');
    expect(api.listAgreementRequests).toHaveBeenCalledTimes(1);
  });

  it('a failed draft delete does not reload the table', async () => {
    api.listAgreementRequests.mockResolvedValue(resp({ data: [row({ status: 'draft', sentAt: null })] }));
    api.deleteAgreementRequest.mockResolvedValue(resp({ error: 'nope' }, 500));
    render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    fireEvent.click(await screen.findByTestId('agreement-request-delete-r1'));
    await waitFor(() => expect(api.deleteAgreementRequest).toHaveBeenCalled());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(api.listAgreementRequests).toHaveBeenCalledTimes(1);
  });

  it('ignores a superseded slow response: the later load rows win', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    api.listAgreementRequests
      .mockImplementationOnce(() => new Promise<Response>((r) => { releaseFirst = r; }))
      .mockResolvedValueOnce(resp({ data: [row({ id: 'closed-1', status: 'voided', voidReason: 'x' })] }));
    const { rerender } = render(<AgreementRequestsTable bucket="pending" orgNames={{}} />);
    rerender(<AgreementRequestsTable bucket="closed" orgNames={{}} />);
    await waitFor(() => expect(screen.getByTestId('agreement-request-row')).toHaveAttribute('data-request-id', 'closed-1'));
    releaseFirst(resp({ data: [row({ id: 'pending-1' })] }));
    await new Promise((r) => setTimeout(r, 20));
    const rows = screen.getAllByTestId('agreement-request-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-request-id', 'closed-1');
  });
});
