import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PeripheralPolicyForm from './PeripheralPolicyForm';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
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

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

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

// #9620: the form has no targeting control. Editing a site/group/device-targeted
// policy must not re-target it to the whole organization, and the form shows the
// current target read-only.
describe('PeripheralPolicyForm — edit keeps targeting (#9620)', () => {
  const sitePolicy = {
    id: 'pol-1',
    name: 'Block USB at HQ',
    deviceClass: 'storage',
    action: 'block',
    isActive: true,
    targetType: 'site',
    targetIds: { siteIds: ['site-1', 'site-2'] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-aaaa', allOrgs: false, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
  });

  it('does not send targeting on save, so the stored target is kept', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse());
    render(<PeripheralPolicyForm policy={sitePolicy} onClose={() => {}} />);
    typeName('Block USB at HQ (renamed)');
    fireEvent.click(screen.getByRole('button', { name: /Update Policy/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    const body = postedBody();
    expect(body).toMatchObject({ id: 'pol-1', name: 'Block USB at HQ (renamed)' });
    expect(body).not.toHaveProperty('targetType');
    expect(body).not.toHaveProperty('targetIds');
  });

  it('shows the current target read-only', () => {
    render(<PeripheralPolicyForm policy={sitePolicy} onClose={() => {}} />);
    expect(screen.getByTestId('peripheral-policy-target')).toHaveTextContent('Specific sites (2)');
  });

  it('still creates org-wide by default', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse());
    render(<PeripheralPolicyForm onClose={() => {}} />);
    expect(screen.queryByTestId('peripheral-policy-target')).toBeNull();
    typeName('Block USB Storage');
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toMatchObject({ targetType: 'organization', targetIds: {} });
  });
});

// #9621: labels pair with their controls, and the exception expiry is edited in
// the browser's local time (it is stored as a UTC ISO string).
describe('PeripheralPolicyForm — accessible labels and local expiry (#9621)', () => {
  const originalTz = process.env.TZ;
  const policyWithExpiry = {
    id: 'pol-9',
    name: 'Temp allow',
    deviceClass: 'storage',
    action: 'block',
    isActive: true,
    targetType: 'organization',
    targetIds: {},
    exceptions: [{ vendor: 'Acme', allow: true, expiresAt: '2026-03-01T03:30:00.000Z' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-aaaa', allOrgs: false, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('pairs the Name, Device Class and Action labels with their controls', () => {
    render(<PeripheralPolicyForm onClose={() => {}} />);
    expect(screen.getByLabelText('Name')).toBe(screen.getByTestId('peripheral-policy-name'));
    expect(screen.getByLabelText('Device Class')).toBe(screen.getByTestId('peripheral-policy-device-class'));
    expect(screen.getByLabelText('Action')).toBe(screen.getByTestId('peripheral-policy-action'));
    expect(screen.getByRole('switch', { name: 'Active' })).toBeTruthy();
  });

  it('labels every exception field', () => {
    render(<PeripheralPolicyForm policy={policyWithExpiry} onClose={() => {}} />);
    for (const label of ['Vendor', 'Product', 'Serial Number', 'Reason']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText(/Expires/)).toBe(screen.getByTestId('peripheral-policy-exception-expires-0'));
  });

  it('shows an existing expiry in local time, not UTC', () => {
    process.env.TZ = 'America/New_York'; // UTC-5 on 2026-03-01
    render(<PeripheralPolicyForm policy={policyWithExpiry} onClose={() => {}} />);
    expect((screen.getByTestId('peripheral-policy-exception-expires-0') as HTMLInputElement).value).toBe('2026-02-28T22:30');
  });

  it('saves a typed local time as the matching UTC instant', async () => {
    process.env.TZ = 'America/New_York';
    fetchWithAuthMock.mockResolvedValueOnce(okResponse());
    render(<PeripheralPolicyForm policy={policyWithExpiry} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('peripheral-policy-exception-expires-0'), { target: { value: '2026-03-02T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /Update Policy/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    const exceptions = postedBody().exceptions as Array<{ expiresAt: string }>;
    expect(exceptions[0]!.expiresAt).toBe('2026-03-02T14:00:00.000Z');
  });
});

describe('PeripheralPolicyForm — save feedback (runAction)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-aaaa', allOrgs: false, organizations: [orgA], organizationsLoaded: true, error: null });
  });

  it('toasts success after creating a policy', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse());
    const onClose = vi.fn();
    render(<PeripheralPolicyForm onClose={onClose} />);
    typeName('Block USB Storage');
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Policy created' }));
  });

  it('toasts the API error and stays open when the save fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad', json: vi.fn().mockResolvedValue({ error: 'Nope' }) } as unknown as Response);
    const onClose = vi.fn();
    render(<PeripheralPolicyForm onClose={onClose} />);
    typeName('Block USB Storage');
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onClose).not.toHaveBeenCalled();
  });
});
