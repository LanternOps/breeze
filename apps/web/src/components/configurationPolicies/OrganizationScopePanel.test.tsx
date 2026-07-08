import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import OrganizationScopePanel from './OrganizationScopePanel';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function jsonRes(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function assignmentsRes(data: Array<{ id: string; level: string; targetId: string; priority: number }>) {
  return jsonRes({ data });
}

function orgsPageRes(orgs: Array<{ id: string; name: string }>, total?: number, page = 1) {
  return jsonRes({ data: orgs, pagination: { page, limit: 100, total: total ?? orgs.length } });
}

// Helper: find a POST/DELETE call by URL substring + method, regardless of
// exact call index — the panel now fires an extra org-list fetch alongside
// the assignments fetch, so index-based assertions would be brittle.
function findCall(urlIncludes: string, method?: string) {
  return fetchWithAuthMock.mock.calls.find((c) => {
    const url = String(c[0]);
    const opts = c[1] as RequestInit | undefined;
    return url.includes(urlIncludes) && (!method || opts?.method === method);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // Safe default for any call not explicitly stubbed by a test (e.g. a
  // refetch-after-mutation) so the queue never underflows into `undefined`.
  fetchWithAuthMock.mockImplementation(() =>
    jsonRes({ data: [], pagination: { page: 1, limit: 100, total: 0 } })
  );
});

describe('OrganizationScopePanel', () => {
  it('checks orgs that already have an organization-level assignment', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([{ id: 'a1', level: 'organization', targetId: 'org-acme', priority: 0 }]))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-acme', name: 'Acme Corp' }, { id: 'org-contoso', name: 'Contoso Ltd' }]));

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const acme = await screen.findByRole('checkbox', { name: /Acme Corp/i });
    expect(acme).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Contoso Ltd/i })).not.toBeChecked();
  });

  it('POSTs an organization assignment when an org is checked', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([]))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-acme', name: 'Acme Corp' }, { id: 'org-contoso', name: 'Contoso Ltd' }]));

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const contoso = await screen.findByRole('checkbox', { name: /Contoso Ltd/i });
    fireEvent.click(contoso);

    await waitFor(() => expect(findCall('/configuration-policies/p1/assignments', 'POST')).toBeTruthy());
    const post = findCall('/configuration-policies/p1/assignments', 'POST')!;
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body).toMatchObject({ level: 'organization', targetId: 'org-contoso' });
  });

  it('POSTs a partner assignment (no targetId) when All orgs is toggled on', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([]))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-acme', name: 'Acme Corp' }]));

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const allOrgs = await screen.findByRole('checkbox', { name: /All organizations/i });
    fireEvent.click(allOrgs);

    await waitFor(() => {
      const post = findCall('/configuration-policies/p1/assignments', 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.level).toBe('partner');
      expect(body).not.toHaveProperty('targetId');
    });
  });

  it('deletes every existing org assignment before POSTing the partner row when multiple orgs are assigned and All orgs is toggled on', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([
        { id: 'a1', level: 'organization', targetId: 'org-acme', priority: 0 },
        { id: 'a2', level: 'organization', targetId: 'org-contoso', priority: 0 },
      ]))
      .mockImplementationOnce(() => orgsPageRes([
        { id: 'org-acme', name: 'Acme Corp' },
        { id: 'org-contoso', name: 'Contoso Ltd' },
      ]));

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const acme = await screen.findByRole('checkbox', { name: /Acme Corp/i });
    expect(acme).toBeChecked();

    const allOrgs = screen.getByRole('checkbox', { name: /All organizations/i });
    fireEvent.click(allOrgs);

    await waitFor(() => expect(findCall('/configuration-policies/p1/assignments', 'POST')).toBeTruthy());

    const del1 = findCall('/configuration-policies/p1/assignments/a1', 'DELETE');
    const del2 = findCall('/configuration-policies/p1/assignments/a2', 'DELETE');
    const post = findCall('/configuration-policies/p1/assignments', 'POST');
    expect(del1).toBeTruthy();
    expect(del2).toBeTruthy();

    const delIndex1 = fetchWithAuthMock.mock.calls.indexOf(del1!);
    const delIndex2 = fetchWithAuthMock.mock.calls.indexOf(del2!);
    const postIndex = fetchWithAuthMock.mock.calls.indexOf(post!);
    expect(postIndex).toBeGreaterThan(Math.max(delIndex1, delIndex2));

    const postBody = JSON.parse((post![1] as RequestInit).body as string);
    expect(postBody).toMatchObject({ level: 'partner', priority: 0 });
    expect(postBody).not.toHaveProperty('targetId');
  });

  it('reaches orgs beyond the first page via "Load more"', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([]))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-1', name: 'Org One' }], 2, 1))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-2', name: 'Org Two' }], 2, 2));

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    await screen.findByRole('checkbox', { name: 'Org One' });
    expect(screen.queryByRole('checkbox', { name: 'Org Two' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Load more organizations/i }));

    const orgTwo = await screen.findByRole('checkbox', { name: 'Org Two' });
    expect(orgTwo).toBeInTheDocument();
    // Both page fetches must have hit the partner-scoped org list endpoint.
    expect(findCall('/orgs/organizations?partnerId=')).toBeTruthy();
    const page2Call = fetchWithAuthMock.mock.calls.find((c) => String(c[0]).includes('page=2'));
    expect(page2Call).toBeTruthy();
  });

  // The bug this fix targets: a partner with >50 orgs couldn't reach or
  // un-assign an organization-level assignment beyond the first page. The
  // "Assigned" section must always render it, resolving its name by id even
  // when it's absent from the currently loaded/searched page — and unchecking
  // it must still fire the DELETE.
  it('always renders an assigned org that is not in the current page, and can unassign it', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([{ id: 'a-51', level: 'organization', targetId: 'org-51', priority: 0 }]))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-1', name: 'Org One' }], 51, 1))
      .mockImplementationOnce(() => jsonRes({ id: 'org-51', name: 'Org 51' })); // individual lookup

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);

    const org51 = await screen.findByRole('checkbox', { name: 'Org 51' });
    expect(org51).toBeChecked();

    fireEvent.click(org51);

    await waitFor(() => expect(findCall('/configuration-policies/p1/assignments/a-51', 'DELETE')).toBeTruthy());
  });

  it('issues a server-side search request and resets to page 1', async () => {
    fetchWithAuthMock
      .mockImplementationOnce(() => assignmentsRes([]))
      .mockImplementationOnce(() => orgsPageRes([{ id: 'org-1', name: 'Org One' }]));

    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    await screen.findByRole('checkbox', { name: 'Org One' });

    fetchWithAuthMock.mockImplementationOnce(() => orgsPageRes([{ id: 'org-acme', name: 'Acme Corp' }]));

    const searchBox = screen.getByPlaceholderText('Search organizations...');
    fireEvent.change(searchBox, { target: { value: 'acme' } });

    await waitFor(
      () => {
        const call = fetchWithAuthMock.mock.calls.find((c) => String(c[0]).includes('search=acme'));
        expect(call).toBeTruthy();
        expect(String(call![0])).toContain('page=1');
      },
      { timeout: 2000 }
    );
  });
});
