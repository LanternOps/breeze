import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamSignerGroupsTab from './PamSignerGroupsTab';
import { fetchWithAuth } from '../../stores/auth';
import type { PamSignerGroup } from './types';

type Perm = { resource: string; action: string };

// Mirrors PamRulesTab.permissions.test.tsx / InvoiceEditor.permissions.test.tsx.
// Covers the NEGATIVE gating branch (PR review fix): a caller without
// pam:manage_policy must not see Add signer group or per-row Edit/Delete.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) => selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

const trustedGroup: PamSignerGroup = {
  id: 'grp-1',
  orgId: 'org-1',
  name: 'Trusted vendors',
  description: 'Approved publishers',
  signers: ['Acme Corp'],
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

function installFetchRoutes(groups: PamSignerGroup[]) {
  fetchWithAuthMock.mockImplementation(async () => makeJsonResponse({ success: true, signerGroups: groups }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'devices', action: 'execute' }];
});

describe('PamSignerGroupsTab — permission gating (pam:manage_policy)', () => {
  it('without pam:manage_policy: hides Add signer group and per-row Edit/Delete', async () => {
    installFetchRoutes([trustedGroup]);
    render(<PamSignerGroupsTab />);
    await waitFor(() => screen.getByTestId('pam-signer-group-row-grp-1'));

    expect(screen.queryByTestId('pam-add-signer-group-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pam-signer-group-edit-grp-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pam-signer-group-delete-grp-1')).not.toBeInTheDocument();
  });

  it('with pam:manage_policy: shows Add signer group and per-row Edit/Delete', async () => {
    state.permissions = [{ resource: 'pam', action: 'manage_policy' }];
    installFetchRoutes([trustedGroup]);
    render(<PamSignerGroupsTab />);
    await waitFor(() => screen.getByTestId('pam-signer-group-row-grp-1'));

    expect(screen.getByTestId('pam-add-signer-group-btn')).toBeInTheDocument();
    expect(screen.getByTestId('pam-signer-group-edit-grp-1')).toBeInTheDocument();
    expect(screen.getByTestId('pam-signer-group-delete-grp-1')).toBeInTheDocument();
  });
});
