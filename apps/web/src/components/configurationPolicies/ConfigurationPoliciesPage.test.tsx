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

  it('renders the feature badges the list endpoint now returns', async () => {
    render(<ConfigurationPoliciesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('config-policy-feature-badge')).toHaveTextContent('Patches'),
    );
  });
});
