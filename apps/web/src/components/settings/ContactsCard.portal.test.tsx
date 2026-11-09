import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ContactsCard from './ContactsCard';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const PORTAL = `/orgs/organizations/${ORG}/portal-users`;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function contact(id: string, name: string, email: string | null) {
  return {
    id, orgId: ORG, siteId: null, name, email, phone: null, mobile: null, title: null,
    roles: [], isPrimary: false, notes: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CONTACTS = [
  contact('c-none', 'Nora None', 'nora@acme.test'),
  contact('c-inv', 'Ivy Invited', 'ivy@acme.test'),
  contact('c-act', 'Abe Active', 'abe@acme.test'),
  contact('c-dis', 'Dan Disabled', 'dan@acme.test'),
  contact('c-noem', 'Eve NoEmail', null),
];

function login(id: string, contactId: string, email: string, effectiveStatus: string) {
  return { id, email, name: null, status: 'active', effectiveStatus, receiveNotifications: true,
    lastLoginAt: null, invitedAt: null, contactId, authMethod: 'password', browserAccess: 'granted' };
}

const LOGINS = [
  login('p-inv', 'c-inv', 'ivy@acme.test', 'pending_setup'),
  login('p-act', 'c-act', 'abe@acme.test', 'active'),
  login('p-dis', 'c-dis', 'dan@acme.test', 'disabled'),
];

const COUNTS = {
  invited: 1, already_has_access: 1, no_email: 0,
  email_bound_to_other_contact: 0, duplicate_email_in_batch: 0,
};

type Opts = {
  portalStatus?: number;
  logins?: unknown[];
  contacts?: unknown[];
  total?: number;
  invite?: () => Promise<Response>;
  bulk?: () => Promise<Response>;
  createdContact?: unknown;
  requests?: unknown[];
};

function mockApi(o: Opts = {}) {
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (url.startsWith('/orgs/sites')) return jsonResponse({ data: [] });
    if (url.startsWith(`${PORTAL}/invite-contacts`)) {
      return (o.bulk ?? (() => jsonResponse({
        data: {
          results: [
            { contactId: 'c-none', outcome: 'invited', emailSent: true },
            { contactId: 'c-act', outcome: 'already_has_access', reason: 'active' },
          ],
          counts: COUNTS,
        },
      })))();
    }
    if (url.startsWith(`${PORTAL}/invite`)) {
      return (o.invite ?? (() => jsonResponse({
        data: { id: 'p-new', email: 'x', status: 'invited', contactLink: 'linked' }, emailSent: true,
      })))();
    }
    if (url.startsWith(`/orgs/organizations/${ORG}/portal-access-requests`)) {
      return jsonResponse({ data: o.requests ?? [], hasMore: false });
    }
    if (url.startsWith(PORTAL)) {
      return o.portalStatus && o.portalStatus !== 200
        ? jsonResponse({ error: 'forbidden' }, o.portalStatus)
        : jsonResponse({ data: o.logins ?? LOGINS });
    }
    if (url.startsWith(`/orgs/organizations/${ORG}/contacts`)) {
      if (method === 'POST') return jsonResponse({ data: o.createdContact ?? contact('c-new', 'Newbie', 'new@acme.test') }, 201);
      const rows = o.contacts ?? CONTACTS;
      return jsonResponse({ data: rows, pagination: { page: 1, limit: 25, total: o.total ?? rows.length } });
    }
    return jsonResponse({ data: [] });
  });
}

function postsTo(suffix: string): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchWithAuthMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST' && (c[0] as string).endsWith(suffix))
    .map((c) => ({ url: c[0] as string, body: JSON.parse((c[1] as RequestInit).body as string) }));
}

function portalListCalls() {
  return fetchWithAuthMock.mock.calls.filter(
    (c) => c[0] === PORTAL && (!c[1] || !(c[1] as RequestInit).method),
  ).length;
}

async function renderCard() {
  render(<ContactsCard orgId={ORG} />);
  await waitFor(() => expect(screen.getByTestId('org-contacts-table')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
});

describe('ContactsCard portal access', () => {
  it('shows a Portal status per contact derived from portal users', async () => {
    mockApi();
    await renderCard();
    await waitFor(() => expect(screen.getByTestId('org-contacts-portal-status-c-none')).toBeInTheDocument());
    expect(screen.getByTestId('org-contacts-portal-status-c-none')).toHaveTextContent('No access');
    expect(screen.getByTestId('org-contacts-portal-status-c-inv')).toHaveTextContent('Invited');
    expect(screen.getByTestId('org-contacts-portal-status-c-act')).toHaveTextContent('Active');
    expect(screen.getByTestId('org-contacts-portal-status-c-dis')).toHaveTextContent('Disabled');
  });

  it('shows Requested (and no give/resend) for a contact with a pending access request', async () => {
    mockApi({ requests: [{ id: 'r1', email: 'NORA@acme.test', status: 'pending' }] });
    await renderCard();
    await waitFor(() => expect(screen.getByTestId('org-contacts-portal-status-c-none')).toHaveTextContent('Requested'));
    expect(screen.queryByTestId('org-contacts-portal-give-c-none')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-contacts-portal-resend-c-none')).not.toBeInTheDocument();
  });

  it('hides the Portal column, checkboxes and create checkbox when portal-users returns 403, with no toast', async () => {
    mockApi({ portalStatus: 403 });
    await renderCard();
    await waitFor(() => expect(fetchWithAuthMock.mock.calls.some((c) => c[0] === PORTAL)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('org-contacts-portal-status-c-none')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-contacts-select-c-none')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-contacts-select-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-contacts-portal-give-c-none')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-contacts-add-button'));
    expect(screen.queryByTestId('contact-form-portal-access-input')).not.toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('Give portal access posts {email, name, contactId} and reloads portal status', async () => {
    mockApi();
    await renderCard();
    const btn = await screen.findByTestId('org-contacts-portal-give-c-none');
    const before = portalListCalls();
    fireEvent.click(btn);
    await waitFor(() => expect(postsTo('/invite')).toHaveLength(1));
    expect(postsTo('/invite')[0].body).toEqual({ email: 'nora@acme.test', name: 'Nora None', contactId: 'c-none' });
    await waitFor(() => expect(portalListCalls()).toBe(before + 1));
  });

  it('Resend invite posts the same contact-bound invite', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(await screen.findByTestId('org-contacts-portal-resend-c-inv'));
    await waitFor(() => expect(postsTo('/invite')).toHaveLength(1));
    expect(postsTo('/invite')[0].body).toEqual({ email: 'ivy@acme.test', name: 'Ivy Invited', contactId: 'c-inv' });
  });

  it('offers no portal action for active or disabled contacts, or for a contact without email', async () => {
    mockApi();
    await renderCard();
    await screen.findByTestId('org-contacts-portal-give-c-none');
    for (const id of ['c-act', 'c-dis', 'c-noem']) {
      expect(screen.queryByTestId(`org-contacts-portal-give-${id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`org-contacts-portal-resend-${id}`)).not.toBeInTheDocument();
    }
  });

  it('bulk Give portal access posts the selected contactIds and toasts the outcome counts', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(await screen.findByTestId('org-contacts-select-c-none'));
    fireEvent.click(screen.getByTestId('org-contacts-select-c-act'));
    const bulk = screen.getByTestId('org-contacts-portal-bulk-give');
    expect(bulk).toHaveTextContent('Give portal access (2)');
    fireEvent.click(bulk);
    await waitFor(() => expect(postsTo('/invite-contacts')).toHaveLength(1));
    expect(postsTo('/invite-contacts')[0].body).toEqual({ contactIds: ['c-none', 'c-act'] });
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    const toast = showToastMock.mock.calls[0][0];
    expect(toast.message).toContain('Invited: 1');
    expect(toast.message).toContain('Already has access: 1');
  });

  it('warns when a batch invite reports emailSent:false', async () => {
    mockApi({
      bulk: () => jsonResponse({
        data: {
          results: [{ contactId: 'c-none', outcome: 'invited', emailSent: false }],
          counts: { ...COUNTS, already_has_access: 0 },
        },
      }),
    });
    await renderCard();
    fireEvent.click(await screen.findByTestId('org-contacts-select-c-none'));
    fireEvent.click(screen.getByTestId('org-contacts-portal-bulk-give'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock.mock.calls[0][0].type).toBe('warning');
  });

  it('clears the selection when the page changes', async () => {
    const many = Array.from({ length: 25 }, (_, i) => contact(`c-${i}`, `Person ${i}`, `p${i}@acme.test`));
    mockApi({ contacts: many, total: 30, logins: [] });
    await renderCard();
    fireEvent.click(await screen.findByTestId('org-contacts-select-c-0'));
    expect(screen.getByTestId('org-contacts-portal-bulk-give')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-contacts-next'));
    await waitFor(() =>
      expect(screen.queryByTestId('org-contacts-portal-bulk-give')).not.toBeInTheDocument());
  });

  it('prunes selected ids that vanish from a reload so a stale id is never posted', async () => {
    const rows = [...CONTACTS];
    mockApi({ contacts: rows });
    await renderCard();
    fireEvent.click(await screen.findByTestId('org-contacts-select-c-none'));
    fireEvent.click(screen.getByTestId('org-contacts-select-c-act'));
    expect(screen.getByTestId('org-contacts-portal-bulk-give')).toHaveTextContent('Give portal access (2)');
    // c-act disappears server-side; the next contacts load (triggered here by a
    // create, same path as a row delete) returns the page without it.
    rows.splice(rows.findIndex((r) => (r as { id: string }).id === 'c-act'), 1);
    fireEvent.click(screen.getByTestId('org-contacts-add-button'));
    fireEvent.change(screen.getByTestId('contact-form-name-input'), { target: { value: 'Newbie' } });
    fireEvent.click(screen.getByTestId('contact-form-submit'));
    await waitFor(() => expect(screen.queryByTestId('org-contacts-select-c-act')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('org-contacts-portal-bulk-give')).toHaveTextContent('Give portal access (1)'));
    fireEvent.click(screen.getByTestId('org-contacts-portal-bulk-give'));
    await waitFor(() => expect(postsTo('/invite-contacts')).toHaveLength(1));
    expect(postsTo('/invite-contacts')[0].body).toEqual({ contactIds: ['c-none'] });
  });

  it('select-all selects every row on the page', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(await screen.findByTestId('org-contacts-select-all'));
    expect(screen.getByTestId('org-contacts-portal-bulk-give')).toHaveTextContent('Give portal access (5)');
  });

  it('creating a contact with Give portal access checked invites the created contact', async () => {
    mockApi();
    await renderCard();
    await screen.findByTestId('org-contacts-portal-give-c-none');
    fireEvent.click(screen.getByTestId('org-contacts-add-button'));
    fireEvent.change(screen.getByTestId('contact-form-name-input'), { target: { value: 'Newbie' } });
    fireEvent.change(screen.getByTestId('contact-form-email-input'), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByTestId('contact-form-portal-access-input'));
    fireEvent.click(screen.getByTestId('contact-form-submit'));
    await waitFor(() => expect(postsTo('/invite')).toHaveLength(1));
    expect(postsTo('/invite')[0].body).toEqual({ email: 'new@acme.test', name: 'Newbie', contactId: 'c-new' });
    // the contact POST came first
    const order = fetchWithAuthMock.mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
      .map((c) => c[0] as string);
    expect(order[0]).toBe(`/orgs/organizations/${ORG}/contacts`);
    expect(order[1]).toBe(`${PORTAL}/invite`);
  });

  it('the create checkbox is disabled while the email is blank', async () => {
    mockApi();
    await renderCard();
    await screen.findByTestId('org-contacts-portal-give-c-none');
    fireEvent.click(screen.getByTestId('org-contacts-add-button'));
    const box = screen.getByTestId('contact-form-portal-access-input');
    expect(box).toBeDisabled();
    fireEvent.change(screen.getByTestId('contact-form-email-input'), { target: { value: 'a@b.test' } });
    expect(box).not.toBeDisabled();
  });
});
