import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PeripheralPolicyForm from './PeripheralPolicyForm';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Organization } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore registers an orgId provider at module load.
  registerOrgIdProvider: vi.fn(),
}));

// A partner-scope token, so the ownership selector (#2131) is shown.
vi.mock('../../lib/authScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/authScope')>()),
  getJwtClaims: vi.fn(() => ({ scope: 'partner', partnerId: 'p-1', orgId: null })),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const orgA: Organization = { id: 'org-aaaa', partnerId: 'p-1', name: 'Acme Corp', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const orgB: Organization = { id: 'org-bbbb', partnerId: 'p-1', name: 'Beta Inc', status: 'active', createdAt: '2026-01-01T00:00:00Z' };

function okResponse(): Response {
  return { ok: true, status: 201, statusText: 'Created', json: vi.fn().mockResolvedValue({ data: { id: 'new-1' } }) } as unknown as Response;
}

// The name input has no label association, so reach it as the form's first text box.
function typeName(value: string) {
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value } });
}

function postedBody(): Record<string, unknown> {
  const init = fetchWithAuthMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body));
}

// #8338: an org-owned create must name its organization in the body, the same way the DNS
// integration and device group create forms do (useFleetOrgOwner, #3563).
describe('PeripheralPolicyForm — org-owned create names its organization (#8338)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-aaaa', allOrgs: false, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
  });

  it('sends the selected org without showing a picker in a focused org view', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse());
    render(<PeripheralPolicyForm onClose={() => {}} />);
    expect(screen.queryByTestId('peripheral-policy-org-picker')).toBeNull();
    typeName('Block USB Storage');
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toMatchObject({ orgId: 'org-aaaa', ownerScope: 'organization' });
  });

  describe('All-organizations (fleet) view', () => {
    beforeEach(() => {
      useOrgStore.setState({ currentOrgId: null, allOrgs: true, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
    });

    it('defaults to partner-wide, which needs no organization', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(okResponse());
      render(<PeripheralPolicyForm onClose={() => {}} />);
      expect(screen.queryByTestId('peripheral-policy-org-picker')).toBeNull();
      typeName('Block USB Storage');
      fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
      const body = postedBody();
      expect(body.ownerScope).toBe('partner');
      expect(body).not.toHaveProperty('orgId');
    });

    it('shows an Organization picker and keeps Create disabled until one is chosen', () => {
      render(<PeripheralPolicyForm onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('peripheral-policy-owner-org'));
      typeName('Block USB Storage');

      const select = screen.getByLabelText('Organization') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Acme Corp', 'Beta Inc']));
      const submit = screen.getByRole('button', { name: /Create Policy/i });
      expect(submit).toBeDisabled();
      fireEvent.change(select, { target: { value: 'org-bbbb' } });
      expect(submit).toBeEnabled();
    });

    it('guards a programmatic submit with an in-form error and no request', async () => {
      render(<PeripheralPolicyForm onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('peripheral-policy-owner-org'));
      typeName('Block USB Storage');
      // Bypass the disabled button (Enter key / programmatic submit): the JS guard must still stop it.
      fireEvent.submit(screen.getByLabelText('Organization').closest('form')!);

      expect(await screen.findByText(/Select an organization/i)).toBeInTheDocument();
      expect(fetchWithAuthMock).not.toHaveBeenCalled();
    });

    it('posts the chosen org once one is selected', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(okResponse());
      render(<PeripheralPolicyForm onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('peripheral-policy-owner-org'));
      fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-bbbb' } });
      typeName('Block USB Storage');
      fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
      expect(postedBody()).toMatchObject({ orgId: 'org-bbbb', ownerScope: 'organization' });
    });
  });
});
