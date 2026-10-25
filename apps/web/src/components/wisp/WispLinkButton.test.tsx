import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '@/lib/runAction';

const h = vi.hoisted(() => ({
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as Record<string, unknown>,
  server: true,
  entitlement: 'enabled' as string,
  storeWisp: null as null | Record<string, unknown>,
  fetchWithAuth: vi.fn(),
  addWispLink: vi.fn(),
  listWispLinks: vi.fn(),
  showToast: vi.fn(),
  visibilityOpts: undefined as undefined | { enabled?: boolean },
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));
vi.mock('@/lib/wispVisibility', () => ({ useWispEnabled: (opts?: { enabled?: boolean }) => { h.visibilityOpts = opts; return h.server; } }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => ({ state: h.entitlement }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: (sel: (s: unknown) => unknown) => sel({ wisp: h.storeWisp }) }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/lib/wispLinksApi', () => ({ addWispLink: h.addWispLink, listWispLinks: h.listWispLinks }));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));

import WispLinkButton, { resetWispLinkTargetCache } from './WispLinkButton';

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const threadBody = (threadId: string, grantId: string, status = 'active') => ({
  data: { thread: { id: threadId, focusOrgId: null, summary: '' }, grant: { id: grantId, status, orgId: null, expiresAt: '2026-12-01T00:00:00Z' } },
});
const ticketLink = { id: 'l-1', ref: { kind: 'ticket', id: 't-1', orgId: 'org-1' }, label: '#1 Jam', status: 'open', href: '/tickets/t-1', addedBy: 'user', createdAt: '' };

describe('WispLinkButton (W08 Task 10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWispLinkTargetCache();
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    h.server = true;
    h.entitlement = 'enabled';
    h.storeWisp = null;
    h.listWispLinks.mockResolvedValue([]);
  });

  it.each([
    ['the server flag is off', () => { h.server = false; }],
    ['the token is org-scoped', () => { h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } }; }],
    ['the partner is not entitled', () => { h.entitlement = 'locked'; }],
  ])('renders nothing and reads nothing when %s', async (_why, arrange) => {
    arrange();
    const { container } = render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(h.fetchWithAuth).not.toHaveBeenCalled();
  });

  it('stays hidden when the caller has no active grant for the item (partner-wide, then the item org)', async () => {
    h.fetchWithAuth.mockResolvedValue(res(404, { code: 'no_active_grant' }));
    const { container } = render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(h.fetchWithAuth).toHaveBeenNthCalledWith(1, '/wisp/thread', { skipOrgIdInjection: true });
    expect(h.fetchWithAuth).toHaveBeenNthCalledWith(2, '/wisp/thread?orgId=org-1', { skipOrgIdInjection: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('uses the live Wisp session from the store without a thread read, and posts the item ref', async () => {
    h.storeWisp = { threadId: 'th-store', grantId: 'g-1', status: 'active' };
    h.addWispLink.mockResolvedValue(ticketLink);
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    const button = await screen.findByTestId('wisp-link-button');
    expect(button).toHaveTextContent('Link to Wisp');
    expect(h.fetchWithAuth).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(h.addWispLink).toHaveBeenCalledWith('th-store', { kind: 'ticket', id: 't-1', orgId: 'org-1' }));
    await waitFor(() => expect(screen.getByTestId('wisp-link-button')).toHaveTextContent('Linked in Wisp'));
    expect(screen.getByTestId('wisp-link-button')).toBeDisabled();
  });

  it('falls back to GET /wisp/thread and shows "Linked in Wisp" when the thread already links the item', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, threadBody('th-1', 'g-1')));
    h.listWispLinks.mockResolvedValue([ticketLink]);
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('wisp-link-button')).toHaveTextContent('Linked in Wisp'));
    expect(h.listWispLinks).toHaveBeenCalledWith('th-1');
  });

  it('a paused grant from the store does not offer linking (the server would refuse)', async () => {
    h.storeWisp = { threadId: 'th-store', grantId: 'g-1', status: 'paused' };
    h.fetchWithAuth.mockResolvedValue(res(404, {}));
    const { container } = render(<WispLinkButton kind="device" id="d-1" orgId="org-1" />);
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('a refused add (ActionError, already toasted) keeps the button usable; a 401 is silent', async () => {
    h.storeWisp = { threadId: 'th-store', grantId: 'g-1', status: 'active' };
    h.addWispLink.mockRejectedValueOnce(new ActionError('outside', 403, 'outside_ceiling'));
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('wisp-link-button'));
    await waitFor(() => expect(h.addWispLink).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('wisp-link-button')).not.toBeDisabled());
    expect(screen.getByTestId('wisp-link-button')).toHaveTextContent('Link to Wisp');
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('a non-ActionError failure toasts', async () => {
    h.storeWisp = { threadId: 'th-store', grantId: 'g-1', status: 'active' };
    h.addWispLink.mockRejectedValueOnce(new Error('network'));
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('wisp-link-button'));
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('asks the server whether Wisp is on only for a partner-scoped token', () => {
    h.claims = { status: 'resolved', claims: { scope: 'system', partnerId: null, orgId: null } };
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    expect(h.visibilityOpts).toEqual({ enabled: false });
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" />);
    expect(h.visibilityOpts).toEqual({ enabled: true });
  });

  it('size="sm" matches compact header rows', async () => {
    h.storeWisp = { threadId: 'th-store', grantId: 'g-1', status: 'active' };
    render(<WispLinkButton kind="ticket" id="t-1" orgId="org-1" size="sm" />);
    expect((await screen.findByTestId('wisp-link-button')).className).toContain('text-xs');
  });
});
