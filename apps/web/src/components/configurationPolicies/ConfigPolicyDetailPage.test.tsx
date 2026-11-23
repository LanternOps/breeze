import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The viewer's permissions come from the auth store (UX only). Default: a
// user with devices.write; read-only cases override authUser.
const { authState } = vi.hoisted(() => ({
  authState: { user: { permissions: [{ resource: 'devices', action: 'write' }] } as Record<string, unknown> | null },
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

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
// The Patches stand-in uses the real FeatureTabShell, so the unsaved-changes
// guard is exercised through the shell's own dirty detection.
vi.mock('./featureTabs/PatchTab', async () => {
  const { useFeatureReadOnly } = await import('./featureTabs/featureEditing');
  const { default: FeatureTabShell } = await import('./featureTabs/FeatureTabShell');
  return {
    default: () => (
      <div data-testid="patch-tab-editor" data-read-only={String(useFeatureReadOnly())}>
        <FeatureTabShell title="Patch editor" description="d" icon={<span />} isConfigured={false} saving={false} onSave={() => Promise.resolve()}>
          <input data-testid="patch-field" aria-label="Patch field" />
        </FeatureTabShell>
      </div>
    ),
  };
});
vi.mock('./featureTabs/OneDriveHelperTab', () => ({
  default: () => <div data-testid="onedrive-tab-editor">OneDrive editor</div>,
}));
vi.mock('./featureTabs/BackupTab', () => ({
  default: () => <div data-testid="backup-tab-editor">Backup editor</div>,
}));
vi.mock('./featureTabs/MonitorsTab', () => ({
  default: (props: { siblingLinks?: Array<{ featureType: string }> }) => (
    <div data-testid="monitors-tab-editor" data-sibling-types={(props.siblingLinks ?? []).map((l) => l.featureType).join(',')} />
  ),
}));
vi.mock('./appliesTo/AppliesToPanel', () => ({ default: () => <div data-testid="applies-to-panel" /> }));

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
  extra: Record<string, unknown> = {},
  catalog: Record<string, unknown>[] = []
) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (url === '/monitor-definitions' && method === 'GET') return json({ data: catalog });
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

// Select a feature the way a user does: its rail item.
function openFeature(featureType: string) {
  fireEvent.click(screen.getByTestId(`config-policy-rail-tab-${featureType}`));
}


const setUser = (user: Record<string, unknown> | null) => {
  authState.user = user;
};
const WRITER = { permissions: [{ resource: 'devices', action: 'write' }] };

beforeEach(() => {
  setUser(WRITER);
  getJwtClaimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });
});

describe('ConfigPolicyDetailPage — a11y (#7158)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('gives the icon-only back-to-list link an accessible name', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute(
      'href',
      '/configuration-policies'
    );
  });

  it('links the Name, Description and Status fields of the details form to their labels (#7156)', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByTestId('config-policy-edit-details'));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});

describe('ConfigPolicyDetailPage — page shell (#12469)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('the tab strip is gone: a feature rail and one feature beside it', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.queryByText('More')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Policy features' })).toBeInTheDocument();
    // With no hash the page opens the rail's first feature.
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('region', { name: 'Patches' })).toContainElement(screen.getByTestId('patch-tab-editor'));
    // The details form stays closed until asked for.
    expect(screen.queryByTestId('config-policy-details-form')).toBeNull();
  });

  it('#overview lands on a feature, with the details form open', async () => {
    window.location.hash = '#overview';
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-details-form')).toBeInTheDocument();
    expect(window.location.hash).toBe('#patch');
  });

  it('#overview arriving after mount opens the details form over the first feature', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('backup');
    act(() => {
      window.location.hash = '#overview';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('config-policy-details-form')).toBeInTheDocument();
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(window.location.hash).toBe('#patch');
  });

  it('the header shows Based on, Parent of and Managed by facts', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], {
      orgName: 'Acme',
      parentPolicyId: 'parent-1',
      parentPolicy: { id: 'parent-1', name: 'Baseline', status: 'active', orgId: 'org-1', featureLinks: [] },
      childPolicies: [{ id: 'child-1', name: 'Child A' }],
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-based-on')).toHaveTextContent('Based on Baseline');
    expect(screen.getByTestId('config-policy-parent-of')).toHaveTextContent('Parent of 1 policy');
    expect(screen.getByTestId('config-policy-managed-by')).toHaveTextContent('Managed by Acme');
  });
});

describe('ConfigPolicyDetailPage — read-only viewer (#12469)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  const mutationRequests = () =>
    fetchMock.mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET') !== 'GET');

  it('a read-only viewer sees the reason before any click', async () => {
    // An org user on an MSP-managed policy, against an API without `access`:
    // the page derives the reason and fails closed.
    mockPolicy({ orgId: null, partnerId: 'partner-1' }, [], { appliesTo: { assignmentCount: 0, allOrganizations: false, targets: [], childPolicyCount: 0 } });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-read-only')).toHaveTextContent('Your MSP manages this policy');
    // No mutation control is rendered: details, applies-to, and every feature
    // gets the read-only context.
    expect(screen.queryByTestId('config-policy-edit-details')).toBeNull();
    expect(screen.queryByTestId('config-policy-applies-to-edit')).toBeNull();
    expect(screen.queryByTestId('config-policy-applies-to-assign')).toBeNull();
    expect(screen.getByTestId('patch-tab-editor')).toHaveAttribute('data-read-only', 'true');
    expect(mutationRequests()).toEqual([]);
  });

  it('#assignments and #overview open nothing for a read-only viewer', async () => {
    window.location.hash = '#assignments';
    mockPolicy({ orgId: 'org-1', partnerId: null });
    setUser({ permissions: [{ resource: 'devices', action: 'read' }] });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-read-only')).toHaveTextContent(
      'Your role can view configuration policies but not change them.',
    );
    expect(screen.queryByTestId('config-policy-applies-to-drawer')).toBeNull();
    expect(screen.queryByTestId('applies-to-panel')).toBeNull();
    act(() => {
      window.location.hash = '#overview';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(window.location.hash).toBe('#patch'));
    expect(screen.queryByTestId('config-policy-details-form')).toBeNull();
  });

  it("the API's access decides when it is sent", async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], { access: { canEdit: false, reason: 'site_restricted' } });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-read-only')).toHaveTextContent('Your access is limited to some sites');
    expect(screen.queryByTestId('config-policy-edit-details')).toBeNull();
  });

  it('an editor gets the controls and an editable feature', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.queryByTestId('config-policy-read-only')).toBeNull();
    expect(screen.getByTestId('config-policy-edit-details')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-applies-to-edit')).toBeInTheDocument();
    expect(screen.getByTestId('patch-tab-editor')).toHaveAttribute('data-read-only', 'false');
  });
});

describe('ConfigPolicyDetailPage — org-only feature gating on MSP-managed policies (#2101)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'partner-1' });
    await i18n.changeLanguage('en');
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

  it('OneDrive Helper on an MSP-managed policy says why it is unavailable', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-rail-tab-onedrive_helper')).toHaveAccessibleName(
      'OneDrive Helper, Unavailable on this policy',
    );
    openFeature('onedrive_helper');

    expect(screen.queryByTestId('onedrive-tab-editor')).not.toBeInTheDocument();
    const panel = screen.getByTestId('config-policy-feature-unavailable');
    expect(panel).toHaveTextContent('OneDrive Helper is unavailable on this policy');
    expect(panel).toHaveTextContent('only a policy managed by that organization can set it');
    expect(panel).toHaveTextContent('This policy is managed by your MSP.');
    // No Copy before W5 (plan D17): the reason, with no action.
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it('renders Backup as fully editable on an MSP-managed policy (profiles, spec 2026-07-13)', async () => {
    // backup left ORG_SCOPED_ONLY_FEATURE_TYPES: MSP-managed policies link a
    // dual-ownership backup profile and resolve each org's default destination.
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('backup');

    expect(screen.getByTestId('backup-tab-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('config-policy-feature-unavailable')).not.toBeInTheDocument();
    expect(screen.getByTestId('config-policy-rail-tab-backup')).toHaveAccessibleName('Backup, Not set');
  });

  it('renders Patches (partner-linkable) as fully editable on an MSP-managed policy', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('patch');

    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('config-policy-feature-unavailable')).not.toBeInTheDocument();
  });

  it('renders OneDrive Helper as editable on an org-owned policy', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('onedrive_helper');

    expect(screen.getByTestId('onedrive-tab-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('config-policy-feature-unavailable')).not.toBeInTheDocument();
  });

  it('still gates OneDrive Helper when the MSP-managed policy carries an EXISTING link, and offers removal', async () => {
    // A gated link on an MSP-managed policy shouldn't be creatable today, but
    // may pre-date the restriction. The editor must NOT leak back in — and the
    // leftover link needs a removal path, or it would be permanently stuck.
    const leftover: MockLink = {
      id: 'link-9',
      featureType: 'onedrive_helper',
      featurePolicyId: null,
      inlineSettings: null,
    };
    mockPolicy({ orgId: null, partnerId: 'partner-1' }, [leftover]);
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('onedrive_helper');

    expect(screen.queryByTestId('onedrive-tab-editor')).not.toBeInTheDocument();
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
    // Once removed, the leftover-link warning disappears (the reason stays).
    await waitFor(() =>
      expect(screen.queryByText(/existing onedrive helper configuration/i)).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('config-policy-feature-unavailable')).toBeInTheDocument();
  });

  it('a read-only viewer gets no removal control for the leftover link', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });
    mockPolicy({ orgId: null, partnerId: 'partner-1' }, [
      { id: 'link-9', featureType: 'onedrive_helper', featurePolicyId: null, inlineSettings: null },
    ]);
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('onedrive_helper');
    expect(screen.getByText(/existing onedrive helper configuration/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove configuration/i })).toBeNull();
  });

  it('does not show the leftover-link removal affordance when the gated feature has no existing link', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('onedrive_helper');

    expect(screen.queryByRole('button', { name: /Remove configuration/i })).not.toBeInTheDocument();
  });
});

// Features are deep-linkable via the URL hash (id === FeatureType key), so a
// shared link / the contextual help button lands on the right feature.
describe('ConfigPolicyDetailPage — URL hash deep-linking', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it.each(['#alert_rule', '#monitoring'])('redirects legacy deep link %s to Monitors', async (hash) => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    window.history.replaceState(null, '', `/configuration-policies/pol-1?keep=value${hash}`);
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    expect(await screen.findByTestId('monitors-tab-editor')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-rail-tab-monitors')).toHaveAttribute('aria-current', 'page');
    expect(replace).toHaveBeenCalledWith(null, '', '/configuration-policies/pol-1?keep=value#monitors');
    expect(window.location.hash).toBe('#monitors');
    replace.mockRestore();
  });

  it.each(['#alert_rule', '#monitoring'])('redirects %s after the page has mounted', async (hash) => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    window.location.hash = hash;
    expect(await screen.findByTestId('monitors-tab-editor')).toBeInTheDocument();
    expect(window.location.hash).toBe('#monitors');
  });

  it('passes every feature link on the policy to the Monitors editor as siblingLinks', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [
      { id: 'l-mon', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } },
      { id: 'l-svc', featureType: 'patch', featurePolicyId: null, inlineSettings: {} },
    ]);
    window.location.hash = '#monitors';
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    const tab = await screen.findByTestId('monitors-tab-editor');
    expect(tab.getAttribute('data-sibling-types')).toBe('monitors,patch');
  });

  it('selects a feature from the initial hash (#onedrive_helper)', async () => {
    window.location.hash = '#onedrive_helper';
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('onedrive-tab-editor')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-rail-tab-onedrive_helper')).toHaveAttribute('aria-current', 'page');
  });

  it('selecting a feature writes the hash', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('backup');
    expect(window.location.hash).toBe('#backup');
    expect(screen.getByTestId('backup-tab-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-compliance_status'));
    expect(window.location.hash).toBe('#compliance_status');
  });

  it('the rail states each feature from this policy and its parent', async () => {
    mockPolicy(
      { orgId: 'org-1', partnerId: null },
      [{ id: 'l-p', featureType: 'patch', featurePolicyId: null, inlineSettings: {} }],
      {
        parentPolicyId: 'parent-1',
        parentPolicy: {
          id: 'parent-1',
          name: 'Baseline',
          status: 'active',
          orgId: 'org-1',
          featureLinks: [{ id: 'l-b', featureType: 'backup', featurePolicyId: null, inlineSettings: {} }],
        },
      },
    );
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName('Patches, Set here');
    expect(screen.getByTestId('config-policy-rail-tab-backup')).toHaveAccessibleName('Backup, From parent');
    expect(screen.getByTestId('config-policy-rail-tab-pam')).toHaveAccessibleName('Privileged Access, Not set');
  });
});

// #5080: inheritance state is derived entirely from the GET
// /configuration-policies/:id response — no `?linked=` query param, no second
// direct fetch of the parent. It reads in the header, on every feature.
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

  it('shows Based on from policy.parentPolicy with no URL param and no second fetch', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], { parentPolicyId: 'parent-1', parentPolicy });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('backup');

    expect(screen.getByTestId('config-policy-based-on')).toHaveTextContent('Based on Baseline');
    expect(fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies/parent-1')).toBe(false);
  });

  it('links to the parent when it is same-org for an org-scoped caller', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], { parentPolicyId: 'parent-1', parentPolicy });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByRole('link', { name: 'Baseline' })).toHaveAttribute(
      'href',
      '/configuration-policies/parent-1'
    );
  });

  it('names an MSP-managed parent without a link for an org-scoped caller', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: 'p-1' });
    mockPolicy(
      { orgId: 'org-1', partnerId: null },
      [],
      { parentPolicyId: 'parent-1', parentPolicy: { ...parentPolicy, orgId: null } }
    );
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.queryByRole('link', { name: 'Baseline' })).not.toBeInTheDocument();
    expect(screen.getByTestId('config-policy-based-on')).toHaveTextContent('Baseline');
    expect(screen.getByTestId('config-policy-based-on')).toHaveTextContent(/managed by your MSP/i);
  });

  it('links to an MSP-managed parent when the caller is partner-scoped', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' });
    mockPolicy(
      { orgId: 'org-1', partnerId: null },
      [],
      { parentPolicyId: 'parent-1', parentPolicy: { ...parentPolicy, orgId: null } }
    );
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByRole('link', { name: 'Baseline' })).toHaveAttribute(
      'href',
      '/configuration-policies/parent-1'
    );
  });

  it('the header lists the child policies, with links', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [], {
      childPolicies: [
        { id: 'child-1', name: 'Child A' },
        { id: 'child-2', name: 'Child B' },
      ],
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByText(/Parent of 2 polic/i));
    expect(screen.getByRole('link', { name: 'Child A' })).toHaveAttribute('href', '/configuration-policies/child-1');
    expect(screen.getByRole('link', { name: 'Child B' })).toHaveAttribute('href', '/configuration-policies/child-2');
  });

  it('a policy with parentPolicyId null shows no Based on and no Parent of', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.queryByText(/Parent of/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Based on/i)).not.toBeInTheDocument();
  });

  // Regression guard for #5023: the pre-persistence flow set inheritance state
  // from a `?linked=` query param, which a reload/bookmark/list-page visit lost
  // entirely. That param is no longer read at all — only policy.parentPolicy
  // matters — so a leftover `?linked=` from an old bookmark must be inert.
  it('ignores a leftover ?linked= query param — only policy.parentPolicy drives Based on', async () => {
    const originalSearch = window.location.search;
    window.history.replaceState(null, '', '?linked=some-other-policy-id');
    try {
      mockPolicy({ orgId: 'org-1', partnerId: null }); // parentPolicyId: null (mockPolicy default)
      render(<ConfigPolicyDetailPage policyId="pol-1" />);

      await screen.findByRole('heading', { name: 'Test Policy' });
      expect(screen.queryByText(/Based on/i)).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies/some-other-policy-id')
      ).toBe(false);
    } finally {
      window.history.replaceState(null, '', originalSearch);
    }
  });
});

describe('ConfigPolicyDetailPage — unsaved-changes guard (#12469)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  const typeInPatch = () => fireEvent.input(screen.getByTestId('patch-field'), { target: { value: 'edited' } });

  it('the rail item of a dirty feature shows the unsaved dot', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName('Patches, Not set');
    typeInPatch();
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName('Patches (unsaved changes), Not set');
  });

  it('leaving a dirty feature asks first: Stay keeps the edits, Discard switches', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    const editor = screen.getByTestId('patch-tab-editor');
    typeInPatch();

    openFeature('backup');
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(screen.getByTestId('patch-tab-editor')).toBe(editor);
    expect(screen.queryByTestId('backup-tab-editor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).toBeNull());
    expect(screen.getByTestId('patch-tab-editor')).toBe(editor);
    expect((screen.getByTestId('patch-field') as HTMLInputElement).value).toBe('edited');

    openFeature('backup');
    fireEvent.click(await screen.findByTestId('config-policy-discard-confirm'));
    expect(await screen.findByTestId('backup-tab-editor')).toBeInTheDocument();
    expect(window.location.hash).toBe('#backup');
  });

  it('a hash change away from a dirty feature asks first, and Stay restores the hash', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    const editor = screen.getByTestId('patch-tab-editor');
    typeInPatch();

    act(() => {
      window.location.hash = '#backup';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(window.location.hash).toBe('#patch');
    expect(screen.getByTestId('patch-tab-editor')).toBe(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).toBeNull());
    expect(screen.getByTestId('patch-tab-editor')).toBe(editor);
  });

  it('#assignments on a dirty feature opens the drawer without asking and keeps the edits', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    const editor = screen.getByTestId('patch-tab-editor');
    typeInPatch();
    act(() => {
      window.location.hash = '#assignments';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('config-policy-applies-to-drawer')).toBeInTheDocument();
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    expect(screen.getByTestId('patch-tab-editor')).toBe(editor);
    expect((screen.getByTestId('patch-field') as HTMLInputElement).value).toBe('edited');
  });

  it('a clean feature switches without asking', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeature('backup');
    expect(screen.getByTestId('backup-tab-editor')).toBeInTheDocument();
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
  });

  it('a saved feature leaves without asking', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    typeInPatch();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName('Patches, Not set'),
    );
    openFeature('backup');
    expect(screen.getByTestId('backup-tab-editor')).toBeInTheDocument();
  });

  it('leaving the page with unsaved changes is guarded (browser unload and in-app navigation)', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });

    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    typeInPatch();
    expect(unload()).toBe(true);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const nav = new Event('astro:before-preparation', { cancelable: true });
    document.dispatchEvent(nav);
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes on this policy. Leave and discard them?');
    expect(nav.defaultPrevented).toBe(true);
    confirm.mockRestore();
  });

  it('unsaved details also guard leaving the page', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByTestId('config-policy-edit-details'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
