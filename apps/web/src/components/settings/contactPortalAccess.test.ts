import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  derivePortalStatus,
  useContactPortalAccess,
  giveContactPortalAccess,
  giveContactsPortalAccess,
  type PortalLogin,
} from './contactPortalAccess';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));

const navigateToMock = vi.fn();
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...a: unknown[]) => navigateToMock(...a),
}));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

const ORG = 'org-1';
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}|${JSON.stringify(opts)}` : key) as never;

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function login(over: Partial<PortalLogin>): PortalLogin {
  return {
    id: 'l1', email: 'ada@acme.test', contactId: 'c1', authMethod: 'password',
    browserAccess: 'granted', effectiveStatus: 'active', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('derivePortalStatus', () => {
  const contact = { id: 'c1', email: 'ada@acme.test' };
  const cases: Array<[string, PortalLogin[], { id: string; email: string | null }, string]> = [
    ['a bound active login gives active', [login({})], contact, 'active'],
    ['bound pending gives invited', [login({ effectiveStatus: 'pending_setup' })], contact, 'invited'],
    ['bound disabled gives disabled', [login({ effectiveStatus: 'disabled' })], contact, 'disabled'],
    ['an add-in-only login does not count as portal access', [login({ authMethod: 'entra', browserAccess: 'none' })], contact, 'none'],
    ['an Entra login with browser access counts', [login({ authMethod: 'entra', browserAccess: 'granted' })], contact, 'active'],
    ['an unbound active login with the same email (mixed case) gives active',
      [login({ contactId: null, email: 'ADA@Acme.test' })], contact, 'active'],
    ['bound disabled plus another active login bound to the same contact gives active',
      [login({ id: 'a', effectiveStatus: 'disabled' }), login({ id: 'b' })], contact, 'active'],
    ['a login bound to another contact with the same email gives none',
      [login({ contactId: 'other' })], contact, 'none'],
    ['a contact with no email and no bound login gives none',
      [login({ contactId: null })], { id: 'c1', email: null }, 'none'],
  ];
  it.each(cases)('%s', (_n, logins, c, expected) => {
    expect(derivePortalStatus(c, logins).status).toBe(expected);
  });

  it('returns the id of the login it chose', () => {
    expect(derivePortalStatus(contact, [login({ id: 'x' })]).portalUserId).toBe('x');
    expect(derivePortalStatus(contact, []).portalUserId).toBeNull();
  });

  it('contact with a pending request reads Requested', () => {
    expect(derivePortalStatus(contact, [], new Set(['ada@acme.test']))).toEqual({ status: 'requested', portalUserId: null });
    expect(derivePortalStatus({ id: 'c1', email: ' ADA@acme.test ' }, [], new Set(['ada@acme.test'])).status).toBe('requested');
    expect(derivePortalStatus(contact, [login({})], new Set(['ada@acme.test'])).status).toBe('active');
    expect(derivePortalStatus(contact, [], new Set(['other@acme.test'])).status).toBe('none');
  });

  it('an unbound add-in-only login with the contact email does not count (none), and with a pending request reads requested', () => {
    const contact = { id: 'c1', email: 'ada@acme.test' };
    const addInOnly = login({ contactId: null, email: 'ada@acme.test', authMethod: 'entra', browserAccess: 'none' });
    expect(derivePortalStatus(contact, [addInOnly])).toEqual({ status: 'none', portalUserId: null });
    expect(derivePortalStatus(contact, [addInOnly], new Set(['ada@acme.test']))).toEqual({
      status: 'requested',
      portalUserId: null,
    });
  });

  it('prefers a bound login over an unbound same-email login', () => {
    const r = derivePortalStatus(contact, [
      login({ id: 'unbound', contactId: null, effectiveStatus: 'active' }),
      login({ id: 'bound', effectiveStatus: 'pending_setup' }),
    ]);
    expect(r).toEqual({ status: 'invited', portalUserId: 'bound' });
  });
});

describe('useContactPortalAccess', () => {
  it('reports available:false on 403 without a toast', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ error: 'forbidden' }, 403));
    const { result } = renderHook(() => useContactPortalAccess(ORG));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.available).toBe(false);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls.map((c) => c[0])).toContain(`/orgs/organizations/${ORG}/portal-users`);
  });

  it('is available and derives status once logins load; reload refetches', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: [login({})] }));
    const { result } = renderHook(() => useContactPortalAccess(ORG));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.statusFor({ id: 'c1', email: 'ada@acme.test' }).status).toBe('active');
    await act(async () => { await result.current.reload(); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(4);
  });

  it('loads pending requests into the status, asking for the whole pending cap in one page', async () => {
    fetchWithAuthMock.mockImplementation((url: string) =>
      url.includes('portal-access-requests') ? json({ data: [{ email: 'New@Acme.test' }], hasMore: false }) : json({ data: [] }));
    const { result } = renderHook(() => useContactPortalAccess(ORG));
    await waitFor(() => expect(result.current.available).toBe(true));
    await waitFor(() => expect(result.current.statusFor({ id: 'c9', email: 'new@acme.test' }).status).toBe('requested'));
    // An org holds at most 200 pending requests; the list route defaults to 100 per page.
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/orgs/organizations/${ORG}/portal-access-requests?status=pending&limit=200`);
  });

  it.each([
    ['a 500', () => json({ error: 'boom' }, 500)],
    ['a thrown fetch', () => Promise.reject(new Error('network down'))],
  ])('keeps portal access available when the requests fetch fails with %s', async (_label, failRequests) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation((url: string) =>
      url.includes('portal-access-requests') ? failRequests() : json({ data: [login({})] }));
    const { result } = renderHook(() => useContactPortalAccess(ORG));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.statusFor({ id: 'c1', email: 'ada@acme.test' }).status).toBe('active');
    expect(warn).toHaveBeenCalledWith('[useContactPortalAccess] access requests load failed', expect.anything());
    warn.mockRestore();
  });

  it('treats a 403 requests fetch as empty without hiding portal access', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation((url: string) =>
      url.includes('portal-access-requests') ? json({ error: 'forbidden' }, 403) : json({ data: [login({})] }));
    const { result } = renderHook(() => useContactPortalAccess(ORG));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.statusFor({ id: 'c1', email: 'ada@acme.test' }).status).toBe('active');
    warn.mockRestore();
  });

  it('redirects to login on 401', async () => {
    fetchWithAuthMock.mockImplementation(() => json({}, 401));
    const { result } = renderHook(() => useContactPortalAccess(ORG));
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(result.current.available).toBe(false);
  });
});

describe('giveContactPortalAccess', () => {
  it('posts email, name and contactId to the invite route', async () => {
    fetchWithAuthMock.mockImplementation(() =>
      json({ data: { id: 'p1', email: 'ada@acme.test', status: 'invited', contactLink: 'x' }, emailSent: true }));
    await giveContactPortalAccess(ORG, { id: 'c1', email: 'ada@acme.test', name: 'Ada' }, t);
    const [url, init] = fetchWithAuthMock.mock.calls[0];
    expect(url).toBe(`/orgs/organizations/${ORG}/portal-users/invite`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'ada@acme.test', name: 'Ada', contactId: 'c1' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('warns when the email could not be sent', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: { id: 'p1' }, emailSent: false }));
    await giveContactPortalAccess(ORG, { id: 'c1', email: 'ada@acme.test', name: null }, t);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: 'settings:contactsCard.portal.toasts.inviteEmailFailed',
    }));
  });
});

describe('giveContactPortalAccess resend', () => {
  it('uses its own warning copy when a resend email could not be sent', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: { id: 'p1' }, emailSent: false }));
    await giveContactPortalAccess(ORG, { id: 'c1', email: 'ada@acme.test', name: null }, t, { resend: true });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: 'settings:contactsCard.portal.toasts.resendEmailFailed',
    }));
  });
});

describe('giveContactsPortalAccess', () => {
  const results = [
    { contactId: 'c1', outcome: 'invited', portalUserId: 'p1', emailSent: true },
    { contactId: 'c2', outcome: 'no_email' },
  ];
  const counts = {
    invited: 1, already_has_access: 0, no_email: 1,
    email_bound_to_other_contact: 0, duplicate_email_in_batch: 0,
  };

  it('posts contactIds to invite-contacts and returns results', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: { results, counts } }));
    const out = await giveContactsPortalAccess(ORG, ['c1', 'c2'], t);
    const [url, init] = fetchWithAuthMock.mock.calls[0];
    expect(url).toBe(`/orgs/organizations/${ORG}/portal-users/invite-contacts`);
    expect(JSON.parse(init.body)).toEqual({ contactIds: ['c1', 'c2'] });
    expect(out).toEqual(results);
    // something was not invited -> warning, and only nonzero outcomes listed
    const toast = showToastMock.mock.calls[0][0];
    expect(toast.type).toBe('warning');
    expect(toast.message).toContain('contactsCard.portal.outcomes.invited');
    expect(toast.message).toContain('contactsCard.portal.outcomes.no_email');
    expect(toast.message).not.toContain('already_has_access');
  });

  it('is a success toast when everything was invited and delivered', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: {
      results: [{ contactId: 'c1', outcome: 'invited', emailSent: true }],
      counts: { ...counts, no_email: 0 },
    } }));
    await giveContactsPortalAccess(ORG, ['c1'], t);
    expect(showToastMock.mock.calls[0][0].type).toBe('success');
  });

  it('is a warning when any invited result has emailSent:false', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: {
      results: [{ contactId: 'c1', outcome: 'invited', emailSent: false }],
      counts: { ...counts, no_email: 0 },
    } }));
    await giveContactsPortalAccess(ORG, ['c1'], t);
    expect(showToastMock.mock.calls[0][0].type).toBe('warning');
  });

  it('states how many invite emails were not sent', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: {
      results: [
        { contactId: 'c1', outcome: 'invited', emailSent: false },
        { contactId: 'c2', outcome: 'invited', emailSent: true },
        { contactId: 'c3', outcome: 'invited', emailSent: false },
      ],
      counts: { ...counts, invited: 3, no_email: 0 },
    } }));
    await giveContactsPortalAccess(ORG, ['c1', 'c2', 'c3'], t);
    const toast = showToastMock.mock.calls[0][0];
    expect(toast.type).toBe('warning');
    expect(toast.message).toContain('contactsCard.portal.outcomes.emailNotSent');
    expect(toast.message).toContain('{\\"count\\":2}');
  });

  it('omits the not-sent part when every invite email was sent', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: {
      results: [{ contactId: 'c1', outcome: 'invited', emailSent: true }],
      counts: { ...counts, no_email: 0 },
    } }));
    await giveContactsPortalAccess(ORG, ['c1'], t);
    expect(showToastMock.mock.calls[0][0].message).not.toContain('emailNotSent');
  });
});
