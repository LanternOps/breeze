import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Every case in this file describes an already-WARM page: the scope is known
// before the detail page renders, so `useJwtClaims` reports it as resolved
// immediately (pattern: PatchApprovalModal.test.tsx). Default to organization
// scope; individual tests override for the partner-scope banner-link cases.
vi.mock('../../lib/authScope', () => {
  const getJwtClaims = vi.fn(() => ({ scope: 'organization' as const, orgId: 'org-1', partnerId: null }));
  return {
    getJwtClaims,
    useJwtClaims: () => ({ status: 'resolved' as const, claims: getJwtClaims() }),
  };
});
import { getJwtClaims } from '../../lib/authScope';
const getJwtClaimsMock = vi.mocked(getJwtClaims);

// Stand in for the real tab editors so this suite stays focused on the
// page-level gating decision (which tab renders an editor vs. a read-only
// hint) rather than each tab's own fetch/save internals — those are covered
// by the tabs' own test files.
vi.mock('./featureTabs/PatchTab', () => ({
  default: () => <div data-testid="patch-tab-editor">Patch editor</div>,
}));
vi.mock('./featureTabs/OneDriveHelperTab', () => ({
  default: () => <div data-testid="onedrive-tab-editor">OneDrive editor</div>,
}));
vi.mock('./featureTabs/BackupTab', () => ({
  default: () => <div data-testid="backup-tab-editor">Backup editor</div>,
}));
vi.mock('./AssignmentsTab', () => ({ default: () => <div data-testid="assignments-tab" /> }));

import ConfigPolicyDetailPage from './ConfigPolicyDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { i18n, loadLocale } from '../../lib/i18n';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

type MockLink = {
  id: string;
  featureType: string;
  featurePolicyId: string | null;
  inlineSettings: Record<string, unknown> | null;
};

function mockPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  featureLinks: MockLink[] = [],
  extra: Record<string, unknown> = {}
) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (url === '/configuration-policies/pol-1' && method === 'GET') {
      return json({
        id: 'pol-1',
        name: 'Test Policy',
        status: 'active',
        featureLinks,
        parentPolicyId: null,
        parentPolicy: null,
        childPolicies: [],
        ...owner,
        ...extra,
      });
    }
    if (url === '/configuration-policies/pol-1/features' && method === 'GET') {
      return json({ data: featureLinks });
    }
    if (url.startsWith('/configuration-policies/pol-1/features/') && method === 'DELETE') {
      return json({ success: true });
    }
    return json({ error: 'not found' }, false);
  });
}

// OverflowTabs measures button widths via `offsetWidth`, which jsdom always
// reports as 0 — against a `clientWidth` of 0 that collapses to "fits 1 tab"
// (see computeVisible in OverflowTabs.tsx), so every tab past "Overview" ends
// up inside the "More" dropdown in tests. Open it before selecting a tab.
function openFeatureTab(label: string) {
  fireEvent.click(screen.getByText('More'));
  fireEvent.click(screen.getByText(label));
}

describe('ConfigPolicyDetailPage — org-only feature gating on partner-wide policies (#2101)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    // Tab clicks now persist to window.location.hash, so reset it between tests
    // to keep each one starting on the Overview tab (a leaked #backup etc. would
    // pre-select that tab and relabel the OverflowTabs "More" button).
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('keeps the breadcrumb route literal while translating its label in pt-BR', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    mockPolicy({ orgId: 'org-1', partnerId: null });

    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByRole('link', { name: 'Políticas de configuração' })).toHaveAttribute(
      'href',
      '/configuration-policies'
    );
  });

  it('gates the OneDrive Helper tab (org-scoped-only) with an inline hint on a partner-wide policy, instead of the editor', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('OneDrive Helper');

    expect(screen.queryByTestId('onedrive-tab-editor')).not.toBeInTheDocument();
    expect(screen.getByText(/isn't available on partner-wide policies/i)).toBeInTheDocument();
    expect(screen.getByText(/Configure this feature on an organization-scoped policy\./i)).toBeInTheDocument();
  });

  it('renders the Backup tab as fully editable on a partner-wide policy (profiles, spec 2026-07-13)', async () => {
    // backup left ORG_SCOPED_ONLY_FEATURE_TYPES: partner-wide policies link a
    // dual-ownership backup profile and resolve each org's default destination.
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.getByTestId('backup-tab-editor')).toBeInTheDocument();
    expect(screen.queryByText(/isn't available on partner-wide policies/i)).not.toBeInTheDocument();
  });

  it('still renders the Patches tab (partner-linkable) as fully editable on a partner-wide policy', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Patches');

    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(screen.queryByText(/organization-scoped policy/i)).not.toBeInTheDocument();
  });

  it('renders the Backup tab as fully editable (no hint) on an org-owned policy', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.getByTestId('backup-tab-editor')).toBeInTheDocument();
    expect(screen.queryByText(/organization-scoped policy/i)).not.toBeInTheDocument();
  });

  it('marks the gated tab button with an explanatory title (tooltip) on a partner-wide policy', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByText('More'));

    expect(screen.getByText('OneDrive Helper').closest('button')).toHaveAttribute(
      'title',
      expect.stringContaining('Not available on partner-wide policies')
    );
    // Backup graduated to partner-linkable (spec 2026-07-13) — no hint tooltip.
    expect(screen.getByText('Backup').closest('button')).not.toHaveAttribute('title');
    // Patch tab isn't gated, so it shouldn't carry the hint tooltip.
    expect(screen.getByText('Patches').closest('button')).not.toHaveAttribute('title');
  });

  it('still gates the OneDrive Helper tab when the partner-wide policy carries an EXISTING link, and offers removal', async () => {
    // A gated link on a partner-wide policy shouldn't be creatable today, but
    // may pre-date the restriction. The editor must NOT leak back in — and the
    // leftover link needs a removal path, or it would be permanently stuck.
    const backupLink: MockLink = {
      id: 'link-9',
      featureType: 'onedrive_helper',
      featurePolicyId: null,
      inlineSettings: null,
    };
    mockPolicy({ orgId: null, partnerId: 'partner-1' }, [backupLink]);
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('OneDrive Helper');

    expect(screen.queryByTestId('onedrive-tab-editor')).not.toBeInTheDocument();
    expect(screen.getByText(/isn't available on partner-wide policies/i)).toBeInTheDocument();
    expect(screen.getByText(/existing onedrive helper configuration/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove configuration/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) =>
            c[0] === '/configuration-policies/pol-1/features/link-9' &&
            (c[1] as RequestInit)?.method === 'DELETE'
        )
      ).toBe(true)
    );
    // Once removed, the leftover-link warning disappears (the generic hint stays).
    await waitFor(() =>
      expect(screen.queryByText(/existing onedrive helper configuration/i)).not.toBeInTheDocument()
    );
    expect(screen.getByText(/isn't available on partner-wide policies/i)).toBeInTheDocument();
  });

  it('does not show the leftover-link removal affordance when the gated tab has no existing link', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.queryByRole('button', { name: /Remove configuration/i })).not.toBeInTheDocument();
  });
});

// Tabs are deep-linkable via the URL hash (feature-tab id === FeatureType key),
// so a shared link / the contextual help button lands on the right tab.
describe('ConfigPolicyDetailPage — URL hash deep-linking', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('selects a feature tab from the initial hash (#patch)', async () => {
    window.location.hash = '#patch';
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
  });

  // #2336: `#onedrive_helper` used to land on Overview. jsdom reports every
  // measured button width as 0, so OverflowTabs keeps exactly one tab visible
  // and everything else — OneDrive Helper included — lives in the "More"
  // dropdown. That makes this the overflow-tab case: the hash must still
  // select the tab even though its button is never rendered in the nav bar,
  // and the "More" button must show the active tab's label instead.
  it('selects an OVERFLOW feature tab from the initial hash (#onedrive_helper)', async () => {
    window.location.hash = '#onedrive_helper';
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('onedrive-tab-editor')).toBeInTheDocument();
    // The overflow trigger takes on the active tab's identity rather than "More".
    expect(screen.getByRole('button', { name: /OneDrive Helper/i })).toBeInTheDocument();
    expect(screen.queryByText('More')).not.toBeInTheDocument();
  });

  it('writes the tab id to the hash when a tab is selected', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');
    expect(window.location.hash).toBe('#backup');
  });
});

// #5080: inheritance state (banner, children list) is derived entirely from
// the GET /configuration-policies/:id response — no `?linked=` query param,
// no second direct fetch of the parent.
describe('ConfigPolicyDetailPage — inheritance from the API (#5080)', () => {
  const parentPolicy = {
    id: 'parent-1',
    name: 'Baseline',
    status: 'active',
    orgId: 'org-1',
    featureLinks: [
      { id: 'link-p1', featureType: 'backup', featurePolicyId: null, inlineSettings: { retentionDays: 30 } },
    ],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('renders the Inheriting-from banner from policy.parentPolicy with no URL param and no second fetch', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], { parentPolicyId: 'parent-1', parentPolicy });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.getByText(/Inheriting from/i)).toBeInTheDocument();
    expect(screen.getByText('Baseline')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies/parent-1')).toBe(false);
  });

  it('links to the parent when it is same-org for an org-scoped caller', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], { parentPolicyId: 'parent-1', parentPolicy });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.getByRole('link', { name: 'Baseline' })).toHaveAttribute(
      'href',
      '/configuration-policies/parent-1'
    );
  });

  it('shows a "managed by your MSP" hint instead of a link when an org-scoped caller views a child of a partner-wide parent', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: 'p-1' });
    const partnerWideParent = { ...parentPolicy, orgId: null };
    mockPolicy(
      { orgId: 'org-1', partnerId: null },
      [],
      { parentPolicyId: 'parent-1', parentPolicy: partnerWideParent }
    );
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.queryByRole('link', { name: 'Baseline' })).not.toBeInTheDocument();
    expect(screen.getByText('Baseline')).toBeInTheDocument();
    expect(screen.getByText(/managed by your MSP/i)).toBeInTheDocument();
  });

  it('links to a partner-wide parent when the caller is partner-scoped', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' });
    const partnerWideParent = { ...parentPolicy, orgId: null };
    mockPolicy(
      { orgId: 'org-1', partnerId: null },
      [],
      { parentPolicyId: 'parent-1', parentPolicy: partnerWideParent }
    );
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.getByRole('link', { name: 'Baseline' })).toHaveAttribute(
      'href',
      '/configuration-policies/parent-1'
    );
  });

  it('Overview shows "Inherited by N policies" with links when childPolicies is non-empty', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], {
      childPolicies: [
        { id: 'child-1', name: 'Child A' },
        { id: 'child-2', name: 'Child B' },
      ],
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByText(/Inherited by 2 polic/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Child A' })).toHaveAttribute('href', '/configuration-policies/child-1');
    expect(screen.getByRole('link', { name: 'Child B' })).toHaveAttribute('href', '/configuration-policies/child-2');
  });

  it('a policy with parentPolicyId null renders no banner and no "Inherited by" line', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.queryByText(/Inherited by/i)).not.toBeInTheDocument();
    openFeatureTab('Backup');
    expect(screen.queryByText(/Inheriting from/i)).not.toBeInTheDocument();
  });

  // Regression guard for #5023: the pre-persistence flow set inheritance state
  // from a `?linked=` query param, which a reload/bookmark/list-page visit lost
  // entirely. That param is no longer read at all — only policy.parentPolicy
  // matters — so a leftover `?linked=` from an old bookmark must be inert.
  it('ignores a leftover ?linked= query param — only policy.parentPolicy drives the banner', async () => {
    const originalSearch = window.location.search;
    window.history.replaceState(null, '', '?linked=some-other-policy-id');
    try {
      mockPolicy({ orgId: 'org-1', partnerId: null }); // parentPolicyId: null (mockPolicy default)
      render(<ConfigPolicyDetailPage policyId="pol-1" />);

      await screen.findByRole('heading', { name: 'Test Policy' });
      openFeatureTab('Backup');
      expect(screen.queryByText(/Inheriting from/i)).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies/some-other-policy-id')
      ).toBe(false);
    } finally {
      window.history.replaceState(null, '', originalSearch);
    }
  });
});
