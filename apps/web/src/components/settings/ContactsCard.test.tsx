import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ContactsCard from './ContactsCard';

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

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_HQ = '22222222-2222-4222-8222-222222222222';
const SITE_DEPOT = '33333333-3333-4333-8333-333333333333';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

const SITES = [
  { id: SITE_HQ, orgId: ORG_ID, name: 'HQ' },
  { id: SITE_DEPOT, orgId: ORG_ID, name: 'Depot' },
];

const CONTACTS = [
  {
    id: 'c-ada', orgId: ORG_ID, siteId: null, name: 'Ada Byron', email: 'ada@acme.test',
    phone: '555-0100', mobile: null, title: 'CTO', roles: ['technical', 'escalation'],
    isPrimary: true, notes: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'c-grace', orgId: ORG_ID, siteId: SITE_HQ, name: 'Grace Hopper',
    email: 'grace@acme.test', phone: null, mobile: '555-0199', title: 'Site lead',
    roles: ['site'], isPrimary: true, notes: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'c-alan', orgId: ORG_ID, siteId: SITE_DEPOT, name: 'Alan Turing',
    email: null, phone: '555-0111', mobile: null, title: null, roles: [],
    isPrimary: false, notes: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Routes by URL so the contacts list and the sites list can't shadow each other. */
function mockApi(options: {
  contacts?: unknown;
  contactsStatus?: number;
  sites?: unknown;
  sitesStatus?: number;
} = {}) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.startsWith('/orgs/sites')) {
      return jsonResponse(
        options.sites ?? { data: SITES, pagination: { page: 1, limit: 50, total: SITES.length } },
        options.sitesStatus ?? 200,
      );
    }
    return jsonResponse(
      options.contacts
        ?? { data: CONTACTS, pagination: { page: 1, limit: 25, total: CONTACTS.length } },
      options.contactsStatus ?? 200,
    );
  });
}

const LIST_PREFIX = `/orgs/organizations/${ORG_ID}/contacts`;

/**
 * Every contacts-LIST GET requested so far, oldest first.
 *
 * Deliberately not "every URL containing /contacts": the create POST shares this
 * exact URL and the delete DELETE also matches that substring, so a looser
 * filter counts the mutation itself as the refetch and the "refetches" assertion
 * passes even with the refetch deleted.
 */
function listCalls(): string[] {
  return fetchWithAuthMock.mock.calls
    .filter((c) => {
      const url = c[0] as string;
      if (!url.startsWith(LIST_PREFIX)) return false;
      const method = (c[1] as RequestInit | undefined)?.method;
      return method === undefined || method.toUpperCase() === 'GET';
    })
    .map((c) => c[0] as string);
}

function mutationCalls(): Array<[string, RequestInit]> {
  return fetchWithAuthMock.mock.calls
    .filter((c) => typeof c[1] === 'object' && c[1] !== null && 'method' in (c[1] as object))
    .map((c) => [c[0] as string, c[1] as RequestInit]);
}

async function renderCard() {
  render(<ContactsCard orgId={ORG_ID} />);
  await waitFor(() => expect(screen.getByTestId('org-contacts-table')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ContactsCard list', () => {
  it('renders every contact with its site attribution and primary marker', async () => {
    mockApi();
    await renderCard();

    expect(screen.getByTestId('org-contacts-row-c-ada')).toHaveTextContent('Ada Byron');
    expect(screen.getByTestId('org-contacts-row-c-grace')).toHaveTextContent('Grace Hopper');

    // An org-level contact is attributed to the organization, not to a site.
    expect(screen.getByTestId('org-contacts-site-c-ada')).toHaveTextContent('Organization');
    // A site-pinned contact resolves to the site NAME, not its uuid.
    expect(screen.getByTestId('org-contacts-site-c-grace')).toHaveTextContent('HQ');
    expect(screen.getByTestId('org-contacts-site-c-alan')).toHaveTextContent('Depot');

    // Primary is per SCOPE: an org can hold an org-level primary and one per site.
    expect(screen.getByTestId('org-contacts-primary-c-ada')).toHaveTextContent('Primary (organization)');
    expect(screen.getByTestId('org-contacts-primary-c-grace')).toHaveTextContent('Primary (HQ)');
    expect(screen.queryByTestId('org-contacts-primary-c-alan')).not.toBeInTheDocument();
  });

  it('renders roles as badges', async () => {
    mockApi();
    await renderCard();
    const roles = screen.getByTestId('org-contacts-roles-c-ada');
    expect(roles).toHaveTextContent('Technical');
    expect(roles).toHaveTextContent('Escalation');
  });

  it('reads its sites from the tab organization, not the globally selected one', async () => {
    mockApi();
    await renderCard();
    const siteCall = fetchWithAuthMock.mock.calls.find((c) => (c[0] as string).startsWith('/orgs/sites'));
    expect(siteCall?.[0]).toBe(`/orgs/sites?organizationId=${ORG_ID}&limit=100`);
  });

  it('shows an empty state rather than a bare table', async () => {
    mockApi({ contacts: { data: [], pagination: { page: 1, limit: 25, total: 0 } } });
    render(<ContactsCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByTestId('org-contacts-empty')).toBeInTheDocument());
  });

  it('shows a retryable error when the list fails', async () => {
    mockApi({ contacts: { error: 'boom' }, contactsStatus: 500 });
    render(<ContactsCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByTestId('org-contacts-load-error')).toBeInTheDocument());
  });

  it('redirects to login on a 401 rather than rendering an error', async () => {
    mockApi({ contacts: { error: 'Unauthorized' }, contactsStatus: 401 });
    render(<ContactsCard orgId={ORG_ID} />);
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(screen.queryByTestId('org-contacts-load-error')).not.toBeInTheDocument();
  });
});

describe('ContactsCard filters', () => {
  it('sends siteId=none for the organization-level filter', async () => {
    mockApi();
    await renderCard();
    fireEvent.change(screen.getByTestId('org-contacts-filter-site'), { target: { value: 'none' } });
    await waitFor(() => expect(listCalls().at(-1)).toContain('siteId=none'));
  });

  it('sends the site uuid when a site is picked', async () => {
    mockApi();
    await renderCard();
    fireEvent.change(screen.getByTestId('org-contacts-filter-site'), { target: { value: SITE_HQ } });
    await waitFor(() => expect(listCalls().at(-1)).toContain(`siteId=${SITE_HQ}`));
  });

  it('sends the role filter and omits it again when cleared', async () => {
    mockApi();
    await renderCard();
    fireEvent.change(screen.getByTestId('org-contacts-filter-role'), { target: { value: 'billing' } });
    await waitFor(() => expect(listCalls().at(-1)).toContain('role=billing'));

    fireEvent.change(screen.getByTestId('org-contacts-filter-role'), { target: { value: '' } });
    await waitFor(() => expect(listCalls().at(-1)).not.toContain('role='));
  });

  it('returns to page 1 when a filter changes', async () => {
    mockApi({ contacts: { data: CONTACTS, pagination: { page: 2, limit: 25, total: 60 } } });
    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-next'));
    await waitFor(() => expect(listCalls().at(-1)).toContain('page=2'));

    fireEvent.change(screen.getByTestId('org-contacts-filter-role'), { target: { value: 'admin' } });
    await waitFor(() => expect(listCalls().at(-1)).toContain('page=1'));
  });
});

describe('ContactsCard mutations', () => {
  async function openAddForm() {
    fireEvent.click(screen.getByTestId('org-contacts-add-button'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeInTheDocument());
  }

  it('creates a contact and refetches the list instead of patching state locally', async () => {
    mockApi();
    await renderCard();
    const listsBefore = listCalls().length;
    await openAddForm();

    fireEvent.change(screen.getByTestId('contact-form-name-input'), { target: { value: 'Katherine Johnson' } });
    fireEvent.change(screen.getByTestId('contact-form-email-input'), { target: { value: 'kj@acme.test' } });
    fireEvent.change(screen.getByTestId('contact-form-site-select'), { target: { value: SITE_HQ } });
    fireEvent.click(screen.getByTestId('contact-form-role-billing'));
    fireEvent.click(screen.getByTestId('contact-form-primary-input'));
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => expect(mutationCalls().length).toBe(1));
    const [url, init] = mutationCalls()[0]!;
    expect(url).toBe(`/orgs/organizations/${ORG_ID}/contacts`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      siteId: SITE_HQ,
      name: 'Katherine Johnson',
      email: 'kj@acme.test',
      roles: ['billing'],
      isPrimary: true,
    });

    // Promoting a primary DEMOTES the previous one server-side, so the list is
    // refetched rather than patched — a local patch would leave two rows
    // claiming the same scope.
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listsBefore));
  });

  it('updates a contact through the contact-scoped PATCH path, sending the whole form', async () => {
    mockApi();
    await renderCard();
    // c-ada carries roles and isPrimary, so a partial assertion here would miss
    // the fields the PATCH actually overwrites — the whole draft is sent.
    fireEvent.click(screen.getByTestId('org-contacts-edit-c-ada'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeInTheDocument());

    expect(screen.getByTestId('contact-form-name-input')).toHaveValue('Ada Byron');
    fireEvent.change(screen.getByTestId('contact-form-title-input'), { target: { value: 'Chief Analyst' } });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => expect(mutationCalls().length).toBe(1));
    const [url, init] = mutationCalls()[0]!;
    // The update route carries no organization — reach is re-asserted server-side.
    expect(url).toBe('/orgs/contacts/c-ada');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      siteId: null,
      name: 'Ada Byron',
      email: 'ada@acme.test',
      phone: '555-0100',
      mobile: null,
      title: 'Chief Analyst',
      notes: null,
      roles: ['technical', 'escalation'],
      isPrimary: true,
    });
  });

  it('un-pins a site-scoped contact to organization level with an explicit null', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-edit-c-grace'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeInTheDocument());
    expect(screen.getByTestId('contact-form-site-select')).toHaveValue(SITE_HQ);

    fireEvent.change(screen.getByTestId('contact-form-site-select'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => expect(mutationCalls().length).toBe(1));
    const body = JSON.parse(mutationCalls()[0]![1].body as string);
    expect(body.siteId).toBeNull();
    // Un-pinning must not quietly drop the rest of the person.
    expect(body.roles).toEqual(['site']);
    expect(body.isPrimary).toBe(true);
  });

  it('refetches after an isPrimary toggle, because the server demotes the old primary', async () => {
    mockApi();
    await renderCard();
    const listsBefore = listCalls().length;
    fireEvent.click(screen.getByTestId('org-contacts-edit-c-alan'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contact-form-primary-input'));
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => expect(mutationCalls().length).toBe(1));
    expect(JSON.parse(mutationCalls()[0]![1].body as string).isPrimary).toBe(true);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listsBefore));
  });

  it('closes the form once a create succeeds', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-add-button'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('contact-form-name-input'), { target: { value: 'Katherine Johnson' } });
    fireEvent.click(screen.getByTestId('contact-form-submit'));
    await waitFor(() => expect(screen.queryByTestId('contact-form')).not.toBeInTheDocument());
  });

  it('clears a field with an explicit null rather than an empty string', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-edit-c-ada'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('contact-form-phone-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => expect(mutationCalls().length).toBe(1));
    const body = JSON.parse(mutationCalls()[0]![1].body as string);
    // An omitted key would leave the stored value alone; only an explicit null clears.
    expect(body.phone).toBeNull();
    // siteId null un-pins to organization level.
    expect(body.siteId).toBeNull();
  });

  it('deletes a contact after confirmation and refetches', async () => {
    mockApi();
    await renderCard();
    const listsBefore = listCalls().length;
    fireEvent.click(screen.getByTestId('org-contacts-delete-c-alan'));

    await waitFor(() => expect(mutationCalls().length).toBe(1));
    const [url, init] = mutationCalls()[0]!;
    expect(url).toBe('/orgs/contacts/c-alan');
    expect(init.method).toBe('DELETE');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listsBefore));
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockApi();
    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-delete-c-alan'));
    expect(mutationCalls()).toHaveLength(0);
  });

  it('surfaces a server 400 through runAction and keeps the form filled', async () => {
    mockApi();
    await renderCard();
    await openAddForm();
    fireEvent.change(screen.getByTestId('contact-form-name-input'), { target: { value: 'Katherine Johnson' } });

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({ error: 'Site does not belong to this organization', code: 'site-not-in-org' }, 400),
    );
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: 'Site does not belong to this organization',
        }),
      ),
    );
    // The form stays open with the operator's input intact — a refused save that
    // wipes the draft costs them the retype.
    expect(screen.getByTestId('contact-form')).toBeInTheDocument();
    expect(screen.getByTestId('contact-form-name-input')).toHaveValue('Katherine Johnson');
  });

  it('refuses to submit a contact with no identifier', async () => {
    mockApi();
    await renderCard();
    await openAddForm();
    expect(screen.getByTestId('contact-form-submit')).toBeDisabled();
    expect(screen.getByTestId('contact-form-identifier-hint')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('contact-form-phone-input'), { target: { value: '555-0000' } });
    expect(screen.getByTestId('contact-form-submit')).toBeEnabled();
  });

  it('routes a 401 on save to the login redirect without a toast', async () => {
    mockApi();
    await renderCard();
    await openAddForm();
    fireEvent.change(screen.getByTestId('contact-form-name-input'), { target: { value: 'Katherine' } });

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    fireEvent.click(screen.getByTestId('contact-form-submit'));
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('ContactsCard import panel', () => {
  it('toggles the CSV importer inline', async () => {
    mockApi();
    await renderCard();
    expect(screen.queryByTestId('bulk-contact-import-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('org-contacts-import-button'));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-panel')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('bulk-contact-import-close'));
    await waitFor(() =>
      expect(screen.queryByTestId('bulk-contact-import-panel')).not.toBeInTheDocument(),
    );
  });

  it('refetches the list once the embedded importer actually writes', async () => {
    mockApi();
    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-import-button'));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-panel')).toBeInTheDocument(),
    );

    const csv = 'Full Name,Email Address\nAda Byron,ada@acme.test\n';
    const file = new File([csv], 'contacts.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(screen.getByTestId('bulk-contact-import-file-input'), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-map-name')).toBeInTheDocument(),
    );

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      rows: [{
        index: 0, name: 'Ada Byron', email: 'ada@acme.test', annotation: 'create',
        organizationId: ORG_ID, siteId: null, contactId: null,
      }],
    }));
    fireEvent.click(screen.getByTestId('bulk-contact-import-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-table')).toBeInTheDocument(),
    );

    const listsBefore = listCalls().length;
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-new', name: 'Ada Byron', createdLink: false }],
      updated: [], skipped: [], errors: [],
    }));
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    // onImported fires only when the commit actually wrote something.
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listsBefore));
  });
});

describe('ContactsCard sites', () => {
  it('keeps the contact list usable and says so when the sites call fails', async () => {
    mockApi({ sites: { error: 'boom' }, sitesStatus: 500 });
    await renderCard();

    expect(screen.getByTestId('org-contacts-sites-error')).toBeInTheDocument();
    // The contacts themselves are org-scoped and unaffected.
    expect(screen.getByTestId('org-contacts-row-c-ada')).toHaveTextContent('Ada Byron');
    // A site whose name never arrived reads as unavailable, not as a permission
    // verdict — the server already intersected the caller's allowed sites.
    expect(screen.getByTestId('org-contacts-site-c-grace')).toHaveTextContent('Site unavailable');
  });

  it('re-requests the sites when the notice is retried', async () => {
    mockApi({ sites: { error: 'boom' }, sitesStatus: 500 });
    await renderCard();
    const sitesBefore = fetchWithAuthMock.mock.calls
      .filter((c) => (c[0] as string).startsWith('/orgs/sites')).length;

    mockApi();
    fireEvent.click(screen.getByTestId('org-contacts-sites-retry'));
    await waitFor(() =>
      expect(screen.queryByTestId('org-contacts-sites-error')).not.toBeInTheDocument(),
    );
    expect(
      fetchWithAuthMock.mock.calls.filter((c) => (c[0] as string).startsWith('/orgs/sites')).length,
    ).toBeGreaterThan(sitesBefore);
    expect(screen.getByTestId('org-contacts-site-c-grace')).toHaveTextContent('HQ');
  });
});

describe('ContactsCard pagination', () => {
  it('summarises the range and disables the bound the page sits on', async () => {
    mockApi({ contacts: { data: CONTACTS, pagination: { page: 1, limit: 25, total: 60 } } });
    await renderCard();
    expect(screen.getByTestId('org-contacts-page')).toHaveTextContent('Showing 1 to 25 of 60');
    expect(screen.getByTestId('org-contacts-prev')).toBeDisabled();
    expect(screen.getByTestId('org-contacts-next')).toBeEnabled();

    fireEvent.click(screen.getByTestId('org-contacts-next'));
    await waitFor(() => expect(listCalls().at(-1)).toContain('page=2'));
    fireEvent.click(screen.getByTestId('org-contacts-next'));
    await waitFor(() => expect(listCalls().at(-1)).toContain('page=3'));
    expect(screen.getByTestId('org-contacts-next')).toBeDisabled();
    expect(screen.getByTestId('org-contacts-prev')).toBeEnabled();
  });

  it('falls back to the last page when a delete empties the page it was on', async () => {
    const filler = Array.from({ length: 25 }, (_, i) => ({
      ...CONTACTS[2]!, id: `c-filler-${i}`, name: `Person ${i}`,
    }));
    const last = { ...CONTACTS[2]!, id: 'c-last', name: 'Last Person' };
    let deleted = false;
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/orgs/sites')) {
        return jsonResponse({ data: SITES, pagination: { page: 1, limit: 50, total: SITES.length } });
      }
      if (init?.method === 'DELETE') {
        deleted = true;
        return jsonResponse({ success: true });
      }
      const page = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('page');
      const total = deleted ? 25 : 26;
      const data = page === '2' ? (deleted ? [] : [last]) : filler;
      return jsonResponse({ data, pagination: { page: Number(page), limit: 25, total } });
    });

    await renderCard();
    fireEvent.click(screen.getByTestId('org-contacts-next'));
    await waitFor(() => expect(screen.getByTestId('org-contacts-row-c-last')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-contacts-delete-c-last'));

    // An empty page 2 must send the operator back to page 1, not to "No contacts yet".
    await waitFor(() => expect(listCalls().at(-1)).toContain('page=1'));
    await waitFor(() => expect(screen.getAllByTestId(/^org-contacts-row-/)).toHaveLength(25));
    expect(screen.queryByTestId('org-contacts-empty')).not.toBeInTheDocument();
  });
});

describe('ContactsCard in-flight states', () => {
  it('marks the first load so a slow list is distinguishable from an empty one', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url.startsWith('/orgs/sites')) {
        return jsonResponse({ data: SITES, pagination: { page: 1, limit: 50, total: SITES.length } });
      }
      return new Promise<Response>(() => { /* never settles */ });
    });
    render(<ContactsCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByTestId('org-contacts-loading')).toBeInTheDocument());
    expect(screen.queryByTestId('org-contacts-empty')).not.toBeInTheDocument();
  });

  it('disables the row delete button while its DELETE is in flight', async () => {
    let releaseDelete: ((r: Response) => void) | undefined;
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/orgs/sites')) {
        return jsonResponse({ data: SITES, pagination: { page: 1, limit: 50, total: SITES.length } });
      }
      if (init?.method === 'DELETE') {
        return new Promise<Response>((resolve) => { releaseDelete = resolve; });
      }
      return jsonResponse({ data: CONTACTS, pagination: { page: 1, limit: 25, total: CONTACTS.length } });
    });
    await renderCard();

    fireEvent.click(screen.getByTestId('org-contacts-delete-c-alan'));
    await waitFor(() => expect(screen.getByTestId('org-contacts-delete-c-alan')).toBeDisabled());
    // A second click while the first is in flight would delete nothing but toast twice.
    fireEvent.click(screen.getByTestId('org-contacts-delete-c-alan'));
    expect(mutationCalls()).toHaveLength(1);

    releaseDelete?.(new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await waitFor(() => expect(screen.getByTestId('org-contacts-delete-c-alan')).toBeEnabled());
  });
});

describe('ContactsCard roles', () => {
  it('renders a role token it does not know rather than dropping it', async () => {
    mockApi({
      contacts: {
        data: [{ ...CONTACTS[0]!, roles: ['technical', 'chief_vibes'] }],
        pagination: { page: 1, limit: 25, total: 1 },
      },
    });
    await renderCard();
    const roles = screen.getByTestId('org-contacts-roles-c-ada');
    expect(roles).toHaveTextContent('Technical');
    expect(roles).toHaveTextContent('chief_vibes');
  });
});

describe('ContactsCard load failures', () => {
  it('re-requests the list when the error notice is retried', async () => {
    mockApi({ contacts: { error: 'boom' }, contactsStatus: 500 });
    render(<ContactsCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByTestId('org-contacts-load-error')).toBeInTheDocument());
    const before = listCalls().length;

    mockApi();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('org-contacts-table')).toBeInTheDocument());
    expect(listCalls().length).toBeGreaterThan(before);
  });
});
