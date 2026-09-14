import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSwitcher from './OrgSwitcher';
import { FALLBACK_STATUS_CLASS, statusColors } from '@/lib/orgStatus';

const { mockStoreRef } = vi.hoisted(() => ({ mockStoreRef: { current: null as unknown } }));

vi.mock('@/stores/auth', () => ({ waitForPendingRefresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn().mockResolvedValue('soft') }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/stores/orgStore', () => {
  const snapshot = () => ({
    ...(mockStoreRef.current as Record<string, unknown>),
    selectOrganization: vi.fn(),
    selectAllOrgs: vi.fn(),
    fetchOrganizations: vi.fn(),
  });
  const useOrgStore = vi.fn((selector?: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector ? selector(snapshot()) : snapshot(),
  );
  (useOrgStore as unknown as { getState: () => unknown }).getState = () => snapshot();
  return { useOrgStore };
});

function seed(status: string) {
  mockStoreRef.current = {
    currentOrgId: 'org-a',
    allOrgs: false,
    isLoading: false,
    organizations: [{ id: 'org-a', partnerId: 'p1', name: 'Org A', status, createdAt: '2024-01-01' }],
  };
}

beforeEach(() => {
  seed('trial');
});

describe('OrgSwitcher status badge', () => {
  it('uses the shared org status colours, so Trial is the same pill here as in the org list', () => {
    render(<OrgSwitcher />);
    const badge = screen.getByText('Trial');
    for (const cls of statusColors.trial.split(' ')) expect(badge).toHaveClass(cls);
  });

  it('falls back to the neutral pill for a status the client does not know', () => {
    seed('inactive');
    render(<OrgSwitcher />);
    const badge = screen.getByText('Inactive');
    for (const cls of FALLBACK_STATUS_CLASS.split(' ')) expect(badge).toHaveClass(cls);
  });
});
