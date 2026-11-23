import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const POLICY = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Default Workstation Policy',
  status: 'active',
  orgId: '44444444-4444-4444-4444-444444444444',
  orgName: 'Fabrikam MSP',
  featureLinks: [{ id: 'link-1', featureType: 'patch' }],
};

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
const orgState = vi.hoisted(() => ({ value: { currentOrgId: null as string | null, organizations: [] as { id: string; name: string }[] } }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) => selector(orgState.value),
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
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: [POLICY], pagination: { page: 1, limit: 25, total: 1 } }) });
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
      // Feature labels are translated now (#12306), so under this file's
      // stand-in locale the badge reads the label key, not English.
      expect(screen.getByTestId('config-policy-feature-badge')).toHaveTextContent(
        'xx:policies:configurationPolicies.featureNames.patch.label',
      ),
    );
  });
});

describe('ConfigurationPoliciesPage delete blocked by children (#5080)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: [POLICY], pagination: { page: 1, limit: 25, total: 1 } }) });
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

describe('ConfigurationPoliciesPage carries appliesTo to the list (#12306)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Applies to cell from the list response, not a placeholder', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            ...POLICY,
            appliesTo: {
              assignmentCount: 1,
              allOrganizations: false,
              targets: [
                { assignmentId: 'a-1', level: 'site', targetId: 's-1', name: 'Birch HQ', roleFilter: null, osFilter: null },
              ],
              childPolicyCount: 0,
            },
          },
        ],
        pagination: { page: 1, limit: 25, total: 1 },
      }),
    });
    render(<ConfigurationPoliciesPage />);
    const cell = await screen.findByTestId('config-policy-applies-to-cell');
    expect(cell).toHaveTextContent('Birch HQ');
    expect(screen.queryByTestId('config-policy-not-applied-badge')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server paging and server filters (plan W03d C4)
// ---------------------------------------------------------------------------

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type RouteResult = { status?: number; body: unknown };
type Handler = (q: URLSearchParams) => RouteResult | Promise<RouteResult>;

const respond = ({ status = 200, body }: RouteResult) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const rows = (n: number, prefix = 'Policy') =>
  Array.from({ length: n }, (_, i) => ({
    ...POLICY,
    id: `${prefix}-${i + 1}`,
    name: `${prefix} ${i + 1}`,
  }));

const page = (data: unknown[], total: number, pageNo = 1) => ({
  body: { data, pagination: { page: pageNo, limit: 25, total } },
});

function routeFetch(handler: Handler, onDelete?: () => void) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      onDelete?.();
      return respond({ body: {} });
    }
    if (url.startsWith('/configuration-policies/reach')) return respond({ body: { data: {} } });
    return respond(await handler(new URL(url, 'http://x').searchParams));
  });
}

const listCalls = () =>
  fetchWithAuthMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/configuration-policies?'))
    .map((url) => new URL(url, 'http://x').searchParams);
const mainCalls = () => listCalls().filter((q) => q.get('limit') !== '1');
const countCalls = () => listCalls().filter((q) => q.get('limit') === '1');

describe('ConfigurationPoliciesPage server paging and filters (W03d C4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    orgState.value = { currentOrgId: null, organizations: [] };
  });

  it('the org-filtered list asks for appliesToOrgId', async () => {
    orgState.value = {
      currentOrgId: ORG_A,
      organizations: [
        { id: ORG_A, name: 'Org A' },
        { id: ORG_B, name: 'Org B' },
      ],
    };
    routeFetch(() => page(rows(2), 2));
    render(<ConfigurationPoliciesPage />);
    await screen.findAllByTestId('config-policy-row');
    expect(mainCalls().length).toBeGreaterThan(0);
    for (const q of listCalls()) {
      expect(q.get('appliesToOrgId')).toBe(ORG_A);
      expect(q.has('orgId')).toBe(false);
    }
  });

  it('still sends the switcher org when there is no org select to show', async () => {
    orgState.value = { currentOrgId: ORG_A, organizations: [{ id: ORG_A, name: 'Org A' }] };
    routeFetch(() => page(rows(1), 1));
    render(<ConfigurationPoliciesPage />);
    await screen.findAllByTestId('config-policy-row');
    expect(screen.queryByTestId('config-policy-org-filter')).toBeNull();
    expect(mainCalls()[0]!.get('appliesToOrgId')).toBe(ORG_A);
  });

  it('the not-applied filter sends notApplied=true', async () => {
    const user = userEvent.setup();
    routeFetch(() => page(rows(1), 1));
    render(<ConfigurationPoliciesPage />);
    await screen.findAllByTestId('config-policy-row');
    expect(mainCalls().every((q) => !q.has('notApplied'))).toBe(true);

    await user.click(screen.getByTestId('config-policy-not-applied-filter'));
    await waitFor(() => expect(mainCalls().some((q) => q.get('notApplied') === 'true')).toBe(true));
    expect(mainCalls().at(-1)!.get('page')).toBe('1');
    expect(window.location.hash).toContain('notApplied=1');
  });

  it('paging and search go to the server', async () => {
    const user = userEvent.setup();
    routeFetch((q) =>
      q.get('search') === 'zeta' ? page(rows(1, 'Zeta'), 1) : page(rows(25), 60, Number(q.get('page'))),
    );
    render(<ConfigurationPoliciesPage />);
    await screen.findAllByTestId('config-policy-row');
    expect(screen.getAllByTestId('config-policy-row')).toHaveLength(25);

    await user.click(screen.getByTestId('config-policy-next-page'));
    await waitFor(() => expect(mainCalls().some((q) => q.get('page') === '2')).toBe(true));
    expect(mainCalls().at(-1)!.get('limit')).toBe('25');

    await user.type(screen.getByRole('searchbox'), 'zeta');
    await waitFor(() => expect(mainCalls().some((q) => q.get('search') === 'zeta')).toBe(true));
    // Search is debounced: the keystrokes did not each send a request.
    expect(mainCalls().filter((q) => q.has('search'))).toHaveLength(1);
    // And it resets to page 1.
    expect(mainCalls().at(-1)!.get('page')).toBe('1');
    expect(await screen.findByText('Zeta 1')).toBeInTheDocument();
  });

  it("the totals come from the server's total", async () => {
    routeFetch((q) => {
      if (q.get('limit') === '1') {
        if (q.get('status') === 'active') return page(rows(1), 90);
        if (q.get('status') === 'inactive') return page(rows(1), 40);
      }
      return page(rows(25), 137);
    });
    render(<ConfigurationPoliciesPage />);
    await waitFor(() => expect(screen.getByTestId('config-policies-total-count')).toHaveTextContent('137'));
    await waitFor(() => expect(screen.getByTestId('config-policies-active-count')).toHaveTextContent('90'));
    expect(screen.getByTestId('config-policies-inactive-count')).toHaveTextContent('40');
    expect(countCalls()).toHaveLength(2);
  });

  it('a failed count read shows an em dash, never 0', async () => {
    routeFetch((q) => (q.get('limit') === '1' ? { status: 500, body: { error: 'boom' } } : page(rows(2), 2)));
    render(<ConfigurationPoliciesPage />);
    await screen.findAllByTestId('config-policy-row');
    await waitFor(() => expect(screen.getByTestId('config-policies-active-count')).toHaveTextContent('—'));
    expect(screen.getByTestId('config-policies-inactive-count')).toHaveTextContent('—');
    expect(screen.getByTestId('config-policies-total-count')).toHaveTextContent('2');
  });

  it('a slow earlier response never overwrites a newer one', async () => {
    const user = userEvent.setup();
    let releaseSlow: (r: RouteResult) => void = () => {};
    const slow = new Promise<RouteResult>((resolve) => {
      releaseSlow = resolve;
    });
    routeFetch((q) => {
      if (q.get('limit') === '1') return page([], 0);
      if (q.get('status') === 'active') return slow;
      if (q.get('status') === 'inactive') return page(rows(1, 'Newer'), 1);
      return page(rows(1, 'Initial'), 1);
    });
    render(<ConfigurationPoliciesPage />);
    await screen.findByText('Initial 1');

    await user.selectOptions(screen.getByTestId('config-policy-status-filter'), 'active');
    await waitFor(() => expect(mainCalls().some((q) => q.get('status') === 'active')).toBe(true));
    await user.selectOptions(screen.getByTestId('config-policy-status-filter'), 'inactive');
    expect(await screen.findByText('Newer 1')).toBeInTheDocument();

    releaseSlow(page(rows(1, 'Stale'), 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Stale 1')).toBeNull();
    expect(screen.getByText('Newer 1')).toBeInTheDocument();
  });

  it('a 403 on the organization filter is an inline message, not a crash', async () => {
    orgState.value = {
      currentOrgId: ORG_A,
      organizations: [
        { id: ORG_A, name: 'Org A' },
        { id: ORG_B, name: 'Org B' },
      ],
    };
    routeFetch(() => ({ status: 403, body: { error: 'Access to this organization denied' } }));
    render(<ConfigurationPoliciesPage />);
    const msg = await screen.findByTestId('config-policies-org-filter-error');
    expect(msg).toHaveTextContent('orgFilterForbidden');
    // The filter row stays, so the user can pick another organization.
    expect(screen.getByTestId('config-policy-org-filter')).toBeInTheDocument();
  });

  it('moves to the last page when a delete leaves the current page past the end', async () => {
    const user = userEvent.setup();
    window.location.hash = '#page=2';
    let deleted = false;
    routeFetch(
      (q) => {
        if (q.get('limit') === '1') return page([], 0);
        if (!deleted) return page(rows(1, 'Last'), 26, 2);
        return q.get('page') === '2' ? page([], 25, 2) : page(rows(25), 25, 1);
      },
      () => {
        deleted = true;
      },
    );
    render(<ConfigurationPoliciesPage />);
    await screen.findByText('Last 1');
    await user.click(screen.getByTestId('config-policy-delete-button'));
    await user.click(screen.getByTestId('config-policy-delete-confirm'));
    await waitFor(() => expect(mainCalls().at(-1)!.get('page')).toBe('1'));
    expect(await screen.findAllByTestId('config-policy-row')).toHaveLength(25);
  });
});

describe('ConfigurationPoliciesPage empty state under the switcher org (W03d C4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('an org that only follows the switcher still reads as "no policies yet", not "adjust your search"', async () => {
    orgState.value = { currentOrgId: ORG_A, organizations: [{ id: ORG_A, name: 'Org A' }, { id: ORG_B, name: 'Org B' }] };
    routeFetch(() => page([], 0));
    render(<ConfigurationPoliciesPage />);
    expect(await screen.findByText('xx:policies:configurationPolicies.configPolicyList.noPoliciesYet')).toBeInTheDocument();
    expect(screen.queryByText('xx:policies:configurationPolicies.configPolicyList.noPoliciesFoundTryAdjustingYourSearch')).toBeNull();
  });

  it('an org the user chose in the filter is a filter', async () => {
    orgState.value = { currentOrgId: ORG_A, organizations: [{ id: ORG_A, name: 'Org A' }, { id: ORG_B, name: 'Org B' }] };
    window.location.hash = `#org=${ORG_B}`;
    routeFetch(() => page([], 0));
    render(<ConfigurationPoliciesPage />);
    expect(await screen.findByText('xx:policies:configurationPolicies.configPolicyList.noPoliciesFoundTryAdjustingYourSearch')).toBeInTheDocument();
  });
});
