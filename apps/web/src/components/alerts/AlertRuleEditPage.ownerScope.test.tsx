import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Partner scope is detected from the JWT claims (same pattern as
// ConfigPolicyCreatePage — #1724 / #2128). The owner picker also reads
// currentOrgId/allOrgs from the org store, so the mock applies the selector
// to a mutable state object each test can override. AlertRuleEditPage reads
// the store both via destructuring (no selector) and via a selector, so the
// mock must support both call shapes.
const { getJwtClaimsMock, orgState } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null })
  ),
  orgState: {
    current: {
      currentOrgId: null as string | null,
      allOrgs: true,
      organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
    },
  },
}));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: typeof orgState.current) => unknown) => (sel ? sel(orgState.current) : orgState.current),
}));

import AlertRuleEditPage from './AlertRuleEditPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const EXISTING_RULE = {
  id: 'existing',
  name: 'Existing Rule',
  description: '',
  severity: 'medium',
  targets: { type: 'all', ids: [] },
  conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
  notificationChannelIds: [],
  cooldownMinutes: 15,
  autoResolve: false,
};

function mockBackgroundEndpoints() {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/alerts/rules/existing') return Promise.resolve(json({ rule: EXISTING_RULE }));
    if (url === '/orgs/sites') return Promise.resolve(json({ sites: [] }));
    if (url === '/groups') return Promise.resolve(json({ groups: [] }));
    if (url === '/devices') return Promise.resolve(json({ devices: [] }));
    if (url === '/alerts/channels') return Promise.resolve(json({ channels: [] }));
    // POST /alerts/rules (create) and PUT /alerts/rules/:id (edit) both fall
    // through to this default success response.
    return Promise.resolve(json({ id: 'new-rule' }));
  });
}

function postBody(): Record<string, unknown> {
  const post = fetchMock.mock.calls.find(
    (c) => c[0] === '/alerts/rules' && (c[1] as RequestInit)?.method === 'POST'
  );
  expect(post).toBeTruthy();
  return JSON.parse((post![1] as RequestInit).body as string);
}

describe('AlertRuleEditPage — owner scope (#2128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    orgState.current = {
      currentOrgId: null,
      allOrgs: true,
      organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
    };
    mockBackgroundEndpoints();
  });

  it('shows the owner picker on create for a partner-scope user, defaulting to partner-wide in All-orgs scope', async () => {
    render(<AlertRuleEditPage isNew />);
    await waitFor(() => expect(screen.getByTestId('alert-rule-owner')).toBeInTheDocument());
    expect(screen.getByTestId('alert-rule-owner-partner')).toBeChecked();
  });

  it('does not show the owner picker when editing an existing rule, even for partner scope', async () => {
    render(<AlertRuleEditPage ruleId="existing" />);
    await waitFor(() => expect(screen.getByDisplayValue('Existing Rule')).toBeInTheDocument());
    expect(screen.queryByTestId('alert-rule-owner')).not.toBeInTheDocument();
  });

  it('does not show the owner picker on create for an org-scope user', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-9' });
    orgState.current = { currentOrgId: 'org-9', allOrgs: false, organizations: [] };
    render(<AlertRuleEditPage isNew />);
    await waitFor(() => expect(screen.getByPlaceholderText('High CPU Alert')).toBeInTheDocument());
    expect(screen.queryByTestId('alert-rule-owner')).not.toBeInTheDocument();
  });

  it('POSTs ownerScope:partner, targetType:all and drops notificationChannelIds for the default partner-wide selection', async () => {
    render(<AlertRuleEditPage isNew />);
    await waitFor(() => expect(screen.getByTestId('alert-rule-owner')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('High CPU Alert'), { target: { value: 'Fleet-wide CPU' } });
    fireEvent.click(screen.getByText('Create Rule'));

    await waitFor(() => {
      const body = postBody();
      expect(body.ownerScope).toBe('partner');
      expect(body.targetType).toBe('all');
      expect('notificationChannelIds' in body).toBe(false);
      expect(body.name).toBe('Fleet-wide CPU');
    });
    expect(navMock).toHaveBeenCalledWith('/alerts/rules');
  });

  it('POSTs orgId (no ownerScope) for an org-scope create with a focused org', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-9' });
    orgState.current = { currentOrgId: 'org-9', allOrgs: false, organizations: [] };
    render(<AlertRuleEditPage isNew />);
    await waitFor(() => expect(screen.getByPlaceholderText('High CPU Alert')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('High CPU Alert'), { target: { value: 'Org CPU Rule' } });
    fireEvent.click(screen.getByText('Create Rule'));

    await waitFor(() => {
      const body = postBody();
      expect(body.orgId).toBe('org-9');
      expect('ownerScope' in body).toBe(false);
    });
  });
});
