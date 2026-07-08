import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import OrganizationScopePanel from './OrganizationScopePanel';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) =>
    sel({ organizations: [
      { id: 'org-acme', name: 'Acme Corp' },
      { id: 'org-contoso', name: 'Contoso Ltd' },
    ] }),
}));

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function jsonRes(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

describe('OrganizationScopePanel', () => {
  it('checks orgs that already have an organization-level assignment', async () => {
    fetchWithAuthMock.mockReturnValueOnce(
      jsonRes({ data: [{ id: 'a1', level: 'organization', targetId: 'org-acme', priority: 0 }] })
    );
    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const acme = await screen.findByRole('checkbox', { name: /Acme Corp/i });
    expect(acme).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Contoso Ltd/i })).not.toBeChecked();
  });

  it('POSTs an organization assignment when an org is checked', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonRes({ data: [] }))                       // initial list
      .mockReturnValueOnce(jsonRes({ id: 'a2', level: 'organization', targetId: 'org-contoso' }, true, 201)) // POST
      .mockReturnValueOnce(jsonRes({ data: [{ id: 'a2', level: 'organization', targetId: 'org-contoso', priority: 0 }] })); // refetch
    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const contoso = await screen.findByRole('checkbox', { name: /Contoso Ltd/i });
    fireEvent.click(contoso);
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/configuration-policies/p1/assignments',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toMatchObject({ level: 'organization', targetId: 'org-contoso' });
  });

  it('POSTs a partner assignment (no targetId) when All orgs is toggled on', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonRes({ data: [] }))
      .mockReturnValueOnce(jsonRes({ id: 'ap', level: 'partner', targetId: PARTNER_ID }, true, 201))
      .mockReturnValueOnce(jsonRes({ data: [{ id: 'ap', level: 'partner', targetId: PARTNER_ID, priority: 0 }] }));
    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const allOrgs = await screen.findByRole('checkbox', { name: /All organizations/i });
    fireEvent.click(allOrgs);
    await waitFor(() => {
      const body = JSON.parse((fetchWithAuthMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body.level).toBe('partner');
      expect(body).not.toHaveProperty('targetId');
    });
  });
});
