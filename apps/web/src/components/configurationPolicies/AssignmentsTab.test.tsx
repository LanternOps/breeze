import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  fetchWithAuth.mockReset();
  // Default: assignments list is empty; any target list returns empty.
  fetchWithAuth.mockResolvedValue(jsonResponse({ data: [] }));
});

describe('AssignmentsTab — partner-OWNED policy (all organizations)', () => {
  it('shows the partner-wide banner and no level/target picker', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    expect(
      screen.getByText('This policy applies to all organizations in your partner.')
    ).toBeInTheDocument();
    // The org-owned "Level" picker must not exist for a partner-owned policy.
    expect(screen.queryByText('Level')).not.toBeInTheDocument();
  });

  it('POSTs a partner assignment with no targetId (server-derived) when re-assigning', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);
    // Wait for the empty-assignments add card to appear.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Assign to all organizations/i })).toBeInTheDocument()
    );

    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ id: 'a1', level: 'partner' }, 201));
    fireEvent.click(screen.getByRole('button', { name: /Assign to all organizations/i }));

    await waitFor(() => {
      const post = findPost();
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.level).toBe('partner');
      expect(body).not.toHaveProperty('targetId');
    });
    // The system-scoped partner-list call must NEVER be made.
    const urls = fetchWithAuth.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/orgs/partners'))).toBe(false);
  });

  it('hides the re-assign card once a partner assignment exists', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a1', level: 'partner', targetId: PARTNER_ID, priority: 0 }] })
    );
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);

    await waitFor(() => expect(screen.getByText('All Organizations')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: /Assign to all organizations/i })
    ).not.toBeInTheDocument();
  });

  it('includes priority and role/OS filters in the partner re-assign POST body', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={null} partnerId={PARTNER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Assign to all organizations/i })).toBeInTheDocument()
    );

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Workstation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Windows' }));

    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ id: 'a1', level: 'partner' }, 201));
    fireEvent.click(screen.getByRole('button', { name: /Assign to all organizations/i }));

    await waitFor(() => {
      const post = findPost();
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.level).toBe('partner');
      expect(body).not.toHaveProperty('targetId');
      expect(body.priority).toBe(5);
      expect(body.roleFilter).toEqual(['workstation']);
      expect(body.osFilter).toEqual(['windows']);
    });
  });
});

describe('AssignmentsTab — org-owned policy', () => {
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
