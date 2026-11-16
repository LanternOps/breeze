import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToastMock(...a) }));

import { navigateTo } from '@/lib/navigation';
import { PortalAccessRequestsList } from './PortalAccessRequestsList';
import type { PortalAccessRequestListItem } from './types';

const ORG = 'org-1';
const BASE = `/orgs/organizations/${ORG}/portal-access-requests`;

function res(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function req(id: string, over: Partial<PortalAccessRequestListItem> = {}): PortalAccessRequestListItem {
  return {
    id, email: `${id}@acme.test`, name: `Name ${id}`, source: 'self', status: 'pending',
    requestedAt: '2026-11-01T00:00:00.000Z', lastRequestedAt: '2026-11-02T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z', decidedAt: null, decidedBy: null, portalUserId: null,
    accountExists: false, domainVerified: true, googleHostedDomain: null, ...over,
  };
}

type Route = (url: string, init?: RequestInit) => Promise<Response> | undefined;
function mockApi(lists: PortalAccessRequestListItem[][], post?: Route) {
  let n = 0;
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      const rows = lists[Math.min(n, lists.length - 1)];
      n += 1;
      return res({ data: rows, hasMore: false });
    }
    return post?.(url, init) ?? res({ data: {} });
  });
}
const posts = () => fetchWithAuth.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

beforeEach(() => { vi.clearAllMocks(); });

describe('PortalAccessRequestsList', () => {
  it('renders nothing when there are no pending requests', async () => {
    mockApi([[]]);
    const { container } = render(<PortalAccessRequestsList orgId={ORG} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`${BASE}?status=pending`));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on 403', async () => {
    fetchWithAuth.mockImplementation(() => res({ error: 'forbidden' }, 403));
    const { container } = render(<PortalAccessRequestsList orgId={ORG} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('a failed load shows an error with Retry instead of hiding waiting requests', async () => {
    fetchWithAuth.mockImplementation(() => res({ error: 'boom' }, 500));
    render(<PortalAccessRequestsList orgId={ORG} />);
    expect(await screen.findByTestId('portal-access-requests-load-error')).toHaveTextContent("Couldn't load access requests.");
    mockApi([[req('r1')]]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('portal-access-request-row-r1')).toBeInTheDocument();
  });

  it('approve calls the route via runAction and reloads users', async () => {
    const onChanged = vi.fn();
    mockApi([[req('r1')], []], () => res({ data: { outcome: 'account_created', portalUserId: 'pu1' } }));
    render(<PortalAccessRequestsList orgId={ORG} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId('portal-access-request-approve-r1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posts()[0][0]).toBe(`${BASE}/r1/approve`);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Approved access for r1@acme.test.' }));
    await waitFor(() => expect(screen.queryByTestId('portal-access-requests')).toBeNull());
  });

  it('a 409 ACCOUNT_EXISTS approve shows the friendly copy and does not call onChanged', async () => {
    const onChanged = vi.fn();
    mockApi([[req('r1')]], () => res({ error: 'x', code: 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS' }, 409));
    render(<PortalAccessRequestsList orgId={ORG} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId('portal-access-request-approve-r1'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Already has an account' })));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('accountExists disables approve', async () => {
    mockApi([[req('r1', { accountExists: true })]]);
    render(<PortalAccessRequestsList orgId={ORG} />);
    const btn = await screen.findByTestId('portal-access-request-approve-r1');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('portal-access-request-row-r1')).toHaveTextContent('Already has an account');
  });

  it('deny asks for confirmation then POSTs deny', async () => {
    mockApi([[req('r1')], []], () => res({ data: { status: 'denied' } }));
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('portal-access-request-deny-r1'));
    expect(posts()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('portal-access-request-deny-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${BASE}/r1/deny`);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Denied the request from r1@acme.test.' }));
  });

  it('W4: a bulk row refused because the tenant is no longer proven gets its own label', async () => {
    mockApi([[req('r1')], [req('r1')]], () => res({ data: [
      { requestId: 'r1', result: 'PORTAL_ACCESS_REQUEST_ENTRA_TENANT_NOT_PROVEN' },
    ] }));
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByLabelText('Select all requests'));
    fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
    expect(await screen.findByTestId('portal-access-request-error-r1')).toHaveTextContent(
      "This organization's Microsoft tenant is no longer proven",
    );
  });

  it('bulk decide reports per-row errors', async () => {
    const onChanged = vi.fn();
    mockApi([[req('r1'), req('r2')], [req('r2')]], () => res({ data: [
      { requestId: 'r1', result: 'approved' },
      { requestId: 'r2', result: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED' },
    ] }));
    render(<PortalAccessRequestsList orgId={ORG} onChanged={onChanged} />);
    fireEvent.click(await screen.findByLabelText('Select all requests'));
    fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = posts()[0];
    expect(url).toBe(`${BASE}/decide`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ requestIds: ['r1', 'r2'], decision: 'approve' });
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning', message: '1 of 2 requests decided. The others are marked in the list.' }));
    expect(await screen.findByTestId('portal-access-request-error-r2')).toHaveTextContent('Sign-in already linked to another account');
    expect(screen.queryByTestId('portal-access-request-row-r1')).toBeNull();
  });

  it('bulk all-success shows one success toast', async () => {
    mockApi([[req('r1'), req('r2')], []], () => res({ data: [
      { requestId: 'r1', result: 'denied' }, { requestId: 'r2', result: 'denied' },
    ] }));
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByLabelText('Select all requests'));
    fireEvent.click(screen.getByTestId('portal-access-requests-bulk-deny'));
    expect(await screen.findByTestId('portal-access-request-deny-confirm')).toBeInTheDocument();
    expect(posts()).toHaveLength(0); // the dialog gates the destructive call
    fireEvent.click(screen.getByTestId('portal-access-request-deny-confirm'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: '2 requests decided.' })));
    expect(showToastMock).toHaveBeenCalledTimes(1);
  });

  it('a selection over 100 is decided in batches of 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) => req(`r${i}`));
    mockApi([many, []], (_url, init) => {
      const { requestIds } = JSON.parse((init as RequestInit).body as string) as { requestIds: string[] };
      return res({ data: requestIds.map((requestId) => ({ requestId, result: 'approved' })) });
    });
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByLabelText('Select all requests'));
    fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: '150 requests decided.' })));
    const sizes = posts().map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { requestIds: string[] }).requestIds.length);
    expect(sizes).toEqual([100, 50]);
  });

  it('a bulk decide that fails outright decides nothing and keeps the rows selected', async () => {
    mockApi([[req('r1'), req('r2')]], () => res({ error: 'boom' }, 500));
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByLabelText('Select all requests'));
    fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    expect(screen.getByTestId('portal-access-request-row-r1')).toBeInTheDocument();
    expect(screen.getByLabelText('Select the request from r1@acme.test')).toBeChecked();
  });

  it('a 401 on a later batch hands off to the login redirect without a partial-result toast', async () => {
    const many = Array.from({ length: 150 }, (_, i) => req(`r${i}`));
    let batch = 0;
    mockApi([many, []], (_url, init) => {
      batch += 1;
      if (batch > 1) return res({ error: 'unauthorized' }, 401);
      const { requestIds } = JSON.parse((init as RequestInit).body as string) as { requestIds: string[] };
      return res({ data: requestIds.map((requestId) => ({ requestId, result: 'approved' })) });
    });
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByLabelText('Select all requests'));
    fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
    await waitFor(() => expect(vi.mocked(navigateTo)).toHaveBeenCalledWith('/login', { replace: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a failed refresh after a decision keeps the rows and says the list may be stale', async () => {
    let gets = 0;
    fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') return res({ data: { outcome: 'account_created', portalUserId: 'pu1' } });
      gets += 1;
      return gets === 1 ? res({ data: [req('r1'), req('r2')], hasMore: false }) : res({ error: 'boom' }, 500);
    });
    render(<PortalAccessRequestsList orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('portal-access-request-approve-r1'));
    expect(await screen.findByTestId('portal-access-requests-refresh-error')).toHaveTextContent(
      "Couldn't refresh the access requests, so this list may be out of date.");
    expect(screen.getByTestId('portal-access-request-row-r2')).toBeInTheDocument();
  });

  describe('W6: a self request whose domain is no longer verified', () => {
    it('a self request with domainVerified false shows the badge and a disabled Approve', async () => {
      mockApi([[req('r1', { domainVerified: false }), req('r2')]]);
      render(<PortalAccessRequestsList orgId={ORG} />);
      const approve = await screen.findByTestId('portal-access-request-approve-r1');
      expect(approve).toBeDisabled();
      expect(approve).toHaveAttribute('title', 'Approve is unavailable: invite this person directly if they should have access.');
      const row = screen.getByTestId('portal-access-request-row-r1');
      expect(within(row).getByTestId('access-request-domain-unverified')).toHaveTextContent('Domain no longer verified');
      // Deny stays available, and other rows are unaffected.
      expect(screen.getByTestId('portal-access-request-deny-r1')).not.toBeDisabled();
      expect(screen.getByTestId('portal-access-request-approve-r2')).not.toBeDisabled();
      expect(within(screen.getByTestId('portal-access-request-row-r2')).queryByTestId('access-request-domain-unverified')).toBeNull();
    });

    it('a non-self row (domainVerified null) never shows the badge', async () => {
      mockApi([[req('r1', { source: 'entra', domainVerified: null })]]);
      render(<PortalAccessRequestsList orgId={ORG} />);
      expect(await screen.findByTestId('portal-access-request-approve-r1')).not.toBeDisabled();
      expect(screen.queryByTestId('access-request-domain-unverified')).toBeNull();
    });

    it('an approve that races a domain loss (409) shows the reason and refreshes the row', async () => {
      const onChanged = vi.fn();
      mockApi([[req('r1')], [req('r1', { domainVerified: false })]], () => res({
        error: 'server-side wording that the UI must not show verbatim',
        code: 'PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED',
      }, 409));
      render(<PortalAccessRequestsList orgId={ORG} onChanged={onChanged} />);
      fireEvent.click(await screen.findByTestId('portal-access-request-approve-r1'));
      await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        message: "This person's email domain is no longer verified for this organization. Invite them directly if they should have access.",
      })));
      expect(await screen.findByTestId('access-request-domain-unverified')).toBeInTheDocument();
      expect(screen.getByTestId('portal-access-request-approve-r1')).toBeDisabled();
      expect(onChanged).not.toHaveBeenCalled();
    });

    it('bulk results label domain_not_verified', async () => {
      mockApi([[req('r1')], [req('r1', { domainVerified: false })]], () => res({ data: [
        { requestId: 'r1', result: 'domain_not_verified' },
      ] }));
      render(<PortalAccessRequestsList orgId={ORG} />);
      fireEvent.click(await screen.findByLabelText('Select all requests'));
      fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
      expect(await screen.findByTestId('portal-access-request-error-r1')).toHaveTextContent('Email domain no longer verified');
    });
  });

  describe('W7 (#11384): Google requests', () => {
    const google = (id: string, over: Partial<PortalAccessRequestListItem> = {}) =>
      req(id, { source: 'google', googleHostedDomain: 'acme.example.com', domainVerified: true, ...over });

    it('a google request shows its Workspace domain', async () => {
      mockApi([[google('g1')]]);
      render(<PortalAccessRequestsList orgId={ORG} />);
      const row = await screen.findByTestId('portal-access-request-row-g1');
      expect(within(row).getByTestId('portal-access-request-source-g1')).toHaveTextContent('Google · acme.example.com');
      expect(screen.getByTestId('portal-access-request-approve-g1')).not.toBeDisabled();
      expect(within(row).queryByTestId('access-request-domain-unverified')).toBeNull();
    });

    it('an unverified google request has the badge and a disabled Approve with the reason', async () => {
      mockApi([[google('g1', { domainVerified: false })]]);
      render(<PortalAccessRequestsList orgId={ORG} />);
      const approve = await screen.findByTestId('portal-access-request-approve-g1');
      expect(approve).toBeDisabled();
      expect(approve).toHaveAttribute('aria-describedby', 'portal-access-request-domain-reason-g1');
      const row = screen.getByTestId('portal-access-request-row-g1');
      expect(within(row).getByTestId('access-request-domain-unverified')).toHaveTextContent('Domain no longer verified');
      expect(row).toHaveTextContent('Approve is unavailable: invite this person directly if they should have access.');
      expect(screen.getByTestId('portal-access-request-deny-g1')).not.toBeDisabled();
    });

    it('an approve refused because the Google domain lapsed (409) shows the Google reason', async () => {
      mockApi([[google('g1')], [google('g1', { domainVerified: false })]], () => res({
        error: 'server wording', code: 'PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED',
      }, 409));
      render(<PortalAccessRequestsList orgId={ORG} />);
      fireEvent.click(await screen.findByTestId('portal-access-request-approve-g1'));
      await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        message: "This request's Google Workspace domain is no longer verified for this organization. Verify it again or invite the person directly.",
      })));
      expect(await screen.findByTestId('access-request-domain-unverified')).toBeInTheDocument();
    });

    it('bulk domain_not_verified on a google row names the Workspace domain, on a self row the email domain', async () => {
      mockApi([[google('g1'), req('s1')]], () => res({ data: [
        { requestId: 'g1', result: 'domain_not_verified' },
        { requestId: 's1', result: 'domain_not_verified' },
      ] }));
      render(<PortalAccessRequestsList orgId={ORG} />);
      fireEvent.click(await screen.findByLabelText('Select all requests'));
      fireEvent.click(screen.getByTestId('portal-access-requests-bulk-approve'));
      expect(await screen.findByTestId('portal-access-request-error-g1')).toHaveTextContent('Google Workspace domain no longer verified');
      expect(screen.getByTestId('portal-access-request-error-s1')).toHaveTextContent('Email domain no longer verified');
    });

    it('ships dark: a queue of self and Microsoft requests never says Google', async () => {
      mockApi([[req('s1', { domainVerified: false }), req('e1', { source: 'entra', domainVerified: null })]]);
      const { container } = render(<PortalAccessRequestsList orgId={ORG} />);
      await screen.findByTestId('portal-access-request-row-e1');
      expect(container.textContent ?? '').not.toMatch(/google/i);
    });
  });

  it('says when only the first page of requests is shown', async () => {
    fetchWithAuth.mockImplementation(() => res({ data: [req('r1')], hasMore: true }));
    render(<PortalAccessRequestsList orgId={ORG} />);
    expect(await screen.findByTestId('portal-access-requests-more')).toHaveTextContent(
      'Showing the first 1 requests. Decide these to see the rest.');
  });
});
