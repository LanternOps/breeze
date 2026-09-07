import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const POLICY = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Default Workstation Policy',
  status: 'active',
  orgId: '44444444-4444-4444-4444-444444444444',
  orgName: 'OliveTech',
  featureLinks: [{ id: 'link-1', featureType: 'patch' }],
};

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) => selector({ currentOrgId: null }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Every user-visible string resolves to a NON-English-looking value, standing in
// for a translated locale. The delete-modal gate used to compare `modalMode`
// against i18n.t('…configurationPoliciesPage.delete'); that only matched because
// the en value happened to be the literal lowercase word "delete", so the modal
// silently never opened under fr/de/es/pt (#2950). Under this mock the old code
// fails and the fixed literal comparison passes.
vi.mock('@/lib/i18n', () => ({
  i18n: { t: (key: string) => `xx:${key}` },
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

import ConfigurationPoliciesPage from './ConfigurationPoliciesPage';

describe('ConfigurationPoliciesPage delete flow (#2950)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: [POLICY] }) });
  });

  it('opens the confirmation modal from the row Delete button under a translated locale', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-delete-button')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('config-policy-delete-modal')).toBeNull();

    await user.click(screen.getByTestId('config-policy-delete-button'));

    const modal = screen.getByTestId('config-policy-delete-modal');
    // The modal names the policy being deleted (it also appears in the row).
    expect(modal).toHaveTextContent(POLICY.name);
  });

  it('cancels without issuing a DELETE', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-delete-button')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('config-policy-delete-button'));
    await user.click(screen.getByTestId('config-policy-delete-cancel'));

    expect(screen.queryByTestId('config-policy-delete-modal')).toBeNull();
    expect(
      fetchWithAuthMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);
  });

  it('confirms the delete against the selected policy id', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-delete-button')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('config-policy-delete-button'));
    await user.click(screen.getByTestId('config-policy-delete-confirm'));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/configuration-policies/${POLICY.id}`,
        { method: 'DELETE' },
      ),
    );
  });

  it('surfaces a failed delete to the user instead of hiding it behind the modal', async () => {
    // The confirmation modal is `fixed inset-0 z-50` over an opaque scrim and
    // stays open on failure, so a page-level error banner in normal document
    // flow is painted BEHIND it — the user sees the button re-enable and
    // nothing else. runAction's toast is the only feedback that reaches them.
    const user = userEvent.setup();
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-delete-button')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('config-policy-delete-button'));

    fetchWithAuthMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'Partner-wide policies require full partner org access (orgAccess must be "all")',
      }),
    });
    await user.click(screen.getByTestId('config-policy-delete-confirm'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    const toasted = showToastMock.mock.calls.map(([arg]) => arg);
    expect(toasted).toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
    // The server's actionable reason reaches the user, not a generic string.
    expect(toasted.some((t) => String(t.message).includes('orgAccess'))).toBe(true);
  });

  it('renders the feature badges the list endpoint now returns', async () => {
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-feature-badge')).toHaveTextContent('Patches'),
    );
  });
});

describe('ConfigurationPoliciesPage delete blocked by children (#5080)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: [POLICY] }) });
  });

  it('delete 409 POLICY_HAS_CHILDREN renders the children inside the confirm modal and keeps it open', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-delete-button')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('config-policy-delete-button'));

    fetchWithAuthMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'POLICY_HAS_CHILDREN',
        children: [
          { id: 'child-1', name: 'Child A' },
          { id: 'child-2', name: 'Child B' },
        ],
      }),
    });
    await user.click(screen.getByTestId('config-policy-delete-confirm'));

    const list = await screen.findByTestId('config-policy-delete-children');
    expect(list).toHaveTextContent('Child A');
    expect(list).toHaveTextContent('Child B');
    // Stays open — a blocked delete is not silently closed like a success.
    expect(screen.getByTestId('config-policy-delete-modal')).toBeInTheDocument();
    // A DELETE was actually attempted (not a client-side short-circuit).
    expect(
      fetchWithAuthMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(true);
  });

  it('clears the blocked-children state when the modal is cancelled', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-delete-button')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('config-policy-delete-button'));
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'POLICY_HAS_CHILDREN', children: [{ id: 'child-1', name: 'Child A' }] }),
    });
    await user.click(screen.getByTestId('config-policy-delete-confirm'));
    await screen.findByTestId('config-policy-delete-children');

    await user.click(screen.getByTestId('config-policy-delete-cancel'));
    expect(screen.queryByTestId('config-policy-delete-modal')).toBeNull();

    // Reopening the modal (even on the same policy) must not show stale state.
    await user.click(screen.getByTestId('config-policy-delete-button'));
    expect(screen.queryByTestId('config-policy-delete-children')).toBeNull();
  });
});
