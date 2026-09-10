import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRulesTab from './PamRulesTab';
import { fetchWithAuth } from '../../stores/auth';
import type { PamRule } from './types';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from — same shape as
// InvoiceEditor.permissions.test.tsx. Covers the NEGATIVE gating branch (PR
// review fix): a caller without pam:manage_policy must not see Add rule,
// per-row Edit/Delete/Re-approve, or the Default verdict config control. The
// wildcard-positive sibling (PamRulesTab.test.tsx) never exercises this path.
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

const suspendedRule: PamRule = {
  id: 'rule-suspended',
  orgId: 'org-1',
  name: 'Auto-elevate installer',
  enabled: true,
  priority: 10,
  matchSigner: 'Acme Corp',
  verdict: 'require_approval',
  suspendedVerdict: 'auto_approve',
  reapprovedAt: null,
  reapprovedByUserId: null,
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

function installFetchRoutes(rules: PamRule[]) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
    if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
    if (url === '/pam/config' && method === 'GET') {
      return makeJsonResponse({ success: true, config: { orgId: 'org-1', defaultUnmatchedVerdict: 'require_approval' } });
    }
    return makeJsonResponse({ success: true, rules });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'devices', action: 'execute' }];
});

describe('PamRulesTab — permission gating (pam:manage_policy)', () => {
  it('without pam:manage_policy: hides Add rule, per-row Edit/Delete/Re-approve, and disables the Default verdict control', async () => {
    installFetchRoutes([suspendedRule]);
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-rule-row-rule-suspended'));

    expect(screen.queryByTestId('pam-add-rule-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pam-rule-edit-rule-suspended')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pam-rule-delete-rule-suspended')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pam-rule-reapprove-rule-suspended')).not.toBeInTheDocument();
    // The suspended badge itself is informational, not a write control — stays visible.
    expect(screen.getByTestId('pam-rule-suspended-badge-rule-suspended')).toBeInTheDocument();
    expect(screen.getByTestId('pam-default-unmatched-verdict')).toBeDisabled();
  });

  it('with pam:manage_policy: shows Add rule, per-row Edit/Delete/Re-approve, and enables the Default verdict control', async () => {
    state.permissions = [{ resource: 'pam', action: 'manage_policy' }];
    installFetchRoutes([suspendedRule]);
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-rule-row-rule-suspended'));

    expect(screen.getByTestId('pam-add-rule-btn')).toBeInTheDocument();
    expect(screen.getByTestId('pam-rule-edit-rule-suspended')).toBeInTheDocument();
    expect(screen.getByTestId('pam-rule-delete-rule-suspended')).toBeInTheDocument();
    expect(screen.getByTestId('pam-rule-reapprove-rule-suspended')).toBeInTheDocument();
    expect(screen.getByTestId('pam-default-unmatched-verdict')).not.toBeDisabled();
  });
});
