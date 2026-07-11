import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n } from '@/lib/i18n';

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

import AssignmentsTab from './AssignmentsTab';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const POLICY_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

const findPost = () =>
  fetchWithAuth.mock.calls.find(
    (c) => String(c[0]).endsWith(`/configuration-policies/${POLICY_ID}/assignments`) &&
      (c[1] as RequestInit | undefined)?.method === 'POST'
  );

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchWithAuth.mockReset();
  // Default: assignments list is empty; any target list returns empty.
  fetchWithAuth.mockResolvedValue(jsonResponse({ data: [] }));
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('AssignmentsTab — partner-OWNED policy (all organizations library, #2280)', () => {
  it('delegates to OrganizationScopePanel — no level/target picker, no partner-wide banner', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);

    // OrganizationScopePanel's own heading + master toggle render instead of
    // the old fixed "all organizations" copy and add-assignment card.
    expect(await screen.findByRole('heading', { name: 'Organizations' })).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /All organizations \(partner-wide\)/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByText('This policy applies to all organizations in your partner.')
    ).not.toBeInTheDocument();
    // The org-owned "Level" picker must not exist for a partner-owned policy.
    expect(screen.queryByText('Level')).not.toBeInTheDocument();
  });

  it('lists the partner organizations as a checklist', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // assignments
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'org-acme', name: 'Acme Corp' }, { id: 'org-contoso', name: 'Contoso Ltd' }],
        pagination: { page: 1, limit: 100, total: 2 },
      })); // org list
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);

    expect(await screen.findByRole('checkbox', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Contoso Ltd' })).toBeInTheDocument();
  });

  it('checks the All-orgs toggle when a partner-level assignment already exists', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a1', level: 'partner', targetId: PARTNER_ID, priority: 0 }] })
    );
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /All organizations \(partner-wide\)/i })).toBeChecked()
    );
  });
});

describe('AssignmentsTab — org-owned policy', () => {
  it('updates mounted level options when the locale changes', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} partnerId={null} />);
    expect(await screen.findByRole('option', { name: 'Device Group' })).toBeInTheDocument();

    await act(async () => {
      await applyLocale('pt-BR');
    });

    expect(screen.getByRole('option', { name: 'Grupo de Dispositivos' })).toBeInTheDocument();
  });

  it('does not offer the Partner-Wide level (it is a footgun for org-owned policies)', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} partnerId={null} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    const levelSelect = screen.getByDisplayValue('Organization');
    const optionValues = Array.from(levelSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['organization', 'site', 'device_group', 'device']);
    expect(optionValues).not.toContain('partner');
  });

  it('locks the organization-level target to the owning org and POSTs it without a picker', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} orgName="Acme Inc" partnerId={null} />);

    // The target is pre-filled and locked to the owning org — no dropdown.
    await waitFor(() =>
      expect(screen.getByTestId('locked-org-target')).toHaveTextContent('Acme Inc')
    );
    expect(screen.queryByText(/Select a target/i)).not.toBeInTheDocument();
    // The all-orgs list must never be fetched — the target is fixed.
    const urls = fetchWithAuth.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/orgs/organizations'))).toBe(false);

    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ id: 'a1', level: 'organization' }, 201));
    fireEvent.click(screen.getByRole('button', { name: /^Assign$/i }));

    await waitFor(() => {
      const post = findPost();
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.level).toBe('organization');
      expect(body.targetId).toBe(ORG_ID);
    });
  });

  it('falls back to the org id in the locked target when no orgName is provided', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} partnerId={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('locked-org-target')).toHaveTextContent(ORG_ID)
    );
  });

  it('scopes device-level target options to the owning org', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} orgName="Acme Inc" partnerId={null} />);
    await waitFor(() => expect(screen.getByDisplayValue('Organization')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Organization'), { target: { value: 'device' } });

    await waitFor(() => {
      const urls = fetchWithAuth.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes(`/devices?orgId=${ORG_ID}`))).toBe(true);
    });
  });
});
