import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One-page create (plan W03d C1-C3). The page runs without a policyId; the
// Patches stand-in saves through the real useFeatureLink, so the create
// happens at the one place every feature tab saves through.
const { authState } = vi.hoisted(() => ({
  authState: {
    user: { permissions: [{ resource: 'devices', action: 'write' }], canManagePartnerWide: true } as Record<string, unknown> | null,
  },
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // The page reads the org store, which registers with auth on import.
  registerOrgIdProvider: vi.fn(),
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));
vi.mock('../../lib/authScope', () => {
  const getJwtClaims = vi.fn(() => ({ scope: 'partner' as const, orgId: null, partnerId: 'p-1' }));
  return {
    getJwtClaims,
    useJwtClaims: () => ({ status: 'resolved' as const, claims: getJwtClaims() }),
  };
});
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

vi.mock('./featureTabs/PatchTab', async () => {
  const { default: FeatureTabShell } = await import('./featureTabs/FeatureTabShell');
  const { useFeatureLink } = await import('./featureTabs/useFeatureLink');
  function PatchStandIn(props: { policyId: string; onLinkChanged: (link: unknown, t: string) => void }) {
    const { save, saving, error } = useFeatureLink(props.policyId);
    return (
      <div data-testid="patch-tab-editor" data-policy-id={props.policyId}>
        <FeatureTabShell
          title="Patch editor"
          description="d"
          icon={<span />}
          isConfigured={false}
          saving={saving}
          error={error}
          saveTestId="patch-save"
          onSave={async () => {
            const link = await save(null, { featureType: 'patch', inlineSettings: { sources: ['os'] } });
            if (link) props.onLinkChanged(link, 'patch');
          }}
        >
          <input data-testid="patch-field" aria-label="Patch field" />
        </FeatureTabShell>
      </div>
    );
  }
  return { default: PatchStandIn };
});
vi.mock('./featureTabs/BackupTab', () => ({ default: () => <div data-testid="backup-tab-editor" /> }));
vi.mock('./featureTabs/MonitorsTab', () => ({ default: () => <div data-testid="monitors-tab-editor" /> }));
// The panel's own activation footer is tested in AppliesToPanel.test.tsx;
// here a stand-in drives the page's Activate and Don't apply yet.
vi.mock('./appliesTo/AppliesToPanel', () => ({
  default: (props: {
    policyId: string | null;
    owner: { kind: string };
    suggestedOrg?: { id: string } | null;
    activation?: { onActivate: (p: unknown) => Promise<string | null>; onDontApply: () => Promise<string | null> };
  }) => (
    <div
      data-testid="applies-to-panel"
      data-policy-id={String(props.policyId)}
      data-owner={props.owner.kind}
      data-suggested={props.suggestedOrg?.id ?? ''}
      data-activation={String(!!props.activation)}
    >
      <button
        type="button"
        data-testid="stub-activate"
        onClick={async () => {
          const out = await props.activation!.onActivate({ add: [{ level: 'organization', targetId: 'org-a', priority: 0 }], update: [], remove: [] });
          document.body.setAttribute('data-activate-result', out === null ? 'ok' : out);
        }}
      />
      <button
        type="button"
        data-testid="stub-dont-apply"
        onClick={async () => {
          const out = await props.activation!.onDontApply();
          document.body.setAttribute('data-dont-apply-result', out === null ? 'ok' : out);
        }}
      />
    </div>
  ),
}));

import ConfigPolicyDetailPage from './ConfigPolicyDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { getJwtClaims } from '../../lib/authScope';
import { useOrgStore } from '../../stores/orgStore';
import { i18n } from '../../lib/i18n';

const fetchMock = vi.mocked(fetchWithAuth);
const claimsMock = vi.mocked(getJwtClaims);

const NEW_ID = '10000000-0000-4000-8000-0000000000aa';
const ok = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
const writes = () => calls.filter((c) => c.method !== 'GET');

type Overrides = {
  feature?: Response;
  apply?: Response;
  patch?: Response;
};
function mockApi(o: Overrides = {}) {
  calls = [];
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    const raw = (init as RequestInit | undefined)?.body;
    calls.push({ url, method, body: raw ? JSON.parse(String(raw)) : undefined });
    if (url === '/configuration-policies' && method === 'POST') {
      const body = JSON.parse(String(raw));
      return ok(
        { id: NEW_ID, name: body.name, status: body.status, orgId: body.orgId ?? null, partnerId: 'p-1', parentPolicyId: body.parentPolicyId ?? null },
        201,
      );
    }
    if (url === `/configuration-policies/${NEW_ID}/features` && method === 'POST') {
      return o.feature ?? ok({ id: 'link-1', featureType: 'patch', featurePolicyId: null, inlineSettings: { sources: ['os'] } }, 201);
    }
    if (url === `/configuration-policies/${NEW_ID}/assignments/apply` && method === 'POST') {
      return o.apply ?? ok({ added: [{ id: 'a-1' }], updated: [], removed: [] }, 201);
    }
    if (url === `/configuration-policies/${NEW_ID}` && method === 'PATCH') {
      return o.patch ?? ok({ id: NEW_ID, status: 'active' });
    }
    if (url === `/configuration-policies/${NEW_ID}` && method === 'GET') {
      return ok({
        id: NEW_ID,
        name: 'Workstations',
        status: 'inactive',
        orgId: null,
        partnerId: 'p-1',
        featureLinks: [],
        parentPolicyId: null,
        parentPolicy: null,
        childPolicies: [],
        appliesTo: { assignmentCount: 0, allOrganizations: false, targets: [], childPolicyCount: 0 },
        access: { canEdit: true, reason: null },
      });
    }
    if (url === `/configuration-policies/${NEW_ID}/reach`) return ok({ direct: 0, throughChildren: 0, organizations: 0 });
    if (url.startsWith(`/configuration-policies/${NEW_ID}/precedence`)) return ok({ data: {} });
    return ok({ error: 'not found' }, 404);
  });
}

const setUrl = (url: string) => window.history.replaceState(null, '', url);

async function renderCreate() {
  render(<ConfigPolicyDetailPage />);
  await screen.findByTestId('config-policy-create-header');
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  setUrl('/configuration-policies/new');
  authState.user = { permissions: [{ resource: 'devices', action: 'write' }], canManagePartnerWide: true };
  claimsMock.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' });
  useOrgStore.setState({
    organizations: [
      { id: 'org-a', name: 'Acme' },
      { id: 'org-b', name: 'Birch' },
    ] as never,
    currentOrgId: 'org-a',
  });
  document.body.removeAttribute('data-activate-result');
  document.body.removeAttribute('data-dont-apply-result');
  mockApi();
});
afterEach(() => {
  setUrl('/');
});

describe('create mode on the page shell (C1)', () => {
  it('nothing is created until the first feature save', async () => {
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-backup'));
    expect(await screen.findByTestId('backup-tab-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.change(screen.getByTestId('patch-field'), { target: { value: 'x' } });
    await act(async () => {});
    expect(writes()).toEqual([]);
    expect(screen.getByTestId('patch-tab-editor')).toHaveAttribute('data-policy-id', '');
  });

  it('the first save creates the policy inactive, then saves the feature', async () => {
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[0]).toEqual({
      url: '/configuration-policies',
      method: 'POST',
      body: { name: 'Workstations', status: 'inactive', ownerScope: 'partner' },
    });
    expect(writes()[1]).toMatchObject({ url: `/configuration-policies/${NEW_ID}/features`, method: 'POST' });
    // The page is now the policy's own page, in place.
    expect(window.location.pathname).toBe(`/configuration-policies/${NEW_ID}`);
    expect(window.location.hash).toBe('#patch');
    await waitFor(() => expect(screen.queryByTestId('config-policy-create-header')).toBeNull());
    expect(screen.getByTestId('config-policy-status-pill')).toHaveTextContent('Inactive');
  });

  it('a failed feature save leaves an inactive policy and says so', async () => {
    mockApi({ feature: ok({ error: 'Invalid patch settings' }, 400) });
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    const notice = await screen.findByTestId('config-policy-first-save-failed');
    expect(notice).toHaveTextContent(/saved as Inactive/i);
    expect(notice).toHaveTextContent(/Patches was not saved/);
    expect(window.location.pathname).toBe(`/configuration-policies/${NEW_ID}`);
    // A retry saves the feature on the same policy; no second policy.
    mockApi();
    fireEvent.click(screen.getByTestId('patch-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].url).toBe(`/configuration-policies/${NEW_ID}/features`);
    await waitFor(() => expect(screen.queryByTestId('config-policy-first-save-failed')).toBeNull());
  });

  it('?feature= opens that feature', async () => {
    setUrl('/configuration-policies/new?feature=backup');
    await renderCreate();
    expect(await screen.findByTestId('backup-tab-editor')).toBeInTheDocument();
  });

  it('owner and parent lock after the first save', async () => {
    await renderCreate();
    expect(screen.getByTestId('config-policy-managed-by-select')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-start-from')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-fixed-at-first-save')).toHaveTextContent(/fixed when the policy is first saved/);
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await waitFor(() => expect(screen.queryByTestId('config-policy-create-header')).toBeNull());
    expect(screen.queryByTestId('config-policy-managed-by-select')).toBeNull();
    expect(screen.queryByTestId('config-policy-start-from')).toBeNull();
    expect(screen.getByTestId('config-policy-owner-fixed')).toHaveTextContent(/were fixed when this policy was first saved/);
  });

  it('a name is required before the first save', async () => {
    await renderCreate();
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    expect(await screen.findByTestId('config-policy-create-name-error')).toBeInTheDocument();
    expect(writes()).toEqual([]);
    expect(screen.getByTestId('config-policy-create-header')).toBeInTheDocument();
  });

  it('a parent chosen under Start from is sent on the create', async () => {
    const PARENT = '20000000-0000-4000-8000-0000000000bb';
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/configuration-policies/eligible-parents?ownerScope=partner') {
        return ok({ data: [{ id: PARENT, name: 'MSP baseline', ownerScope: 'partner' }] });
      }
      if (url === `/configuration-policies/${PARENT}`) {
        return ok({ id: PARENT, name: 'MSP baseline', status: 'active', orgId: null, featureLinks: [{ id: 'pl', featureType: 'backup', featurePolicyId: null, inlineSettings: {} }] });
      }
      return base(input, init);
    });
    await renderCreate();
    fireEvent.click(screen.getByTestId('config-policy-start-parent'));
    fireEvent.change(await screen.findByTestId('policy-link-selector'), { target: { value: PARENT } });
    // The rail reads the parent's features before anything is saved.
    await waitFor(() => expect(screen.getByTestId('config-policy-rail-tab-backup')).toHaveTextContent(/From parent/));
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Child' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes()[0].body).toEqual({ name: 'Child', status: 'inactive', ownerScope: 'partner', parentPolicyId: PARENT });
  });
});

describe('owner default and the Managed-by line (C2)', () => {
  it('a full-access partner gets MSP-managed, with the trade stated before the first save', async () => {
    await renderCreate();
    expect(screen.getByTestId('config-policy-managed-by-select')).toHaveValue('__msp__');
    expect(screen.getByTestId('config-policy-owner-trade')).toHaveTextContent(/cannot carry OneDrive Helper/);
  });

  it('a limited partner is never offered MSP-managed, and gets the switcher org', async () => {
    authState.user = { permissions: [{ resource: 'devices', action: 'write' }], canManagePartnerWide: false };
    await renderCreate();
    const select = screen.getByTestId('config-policy-managed-by-select');
    expect(select).toHaveValue('org-a');
    expect(screen.queryByTestId('config-policy-managed-by-msp')).toBeNull();
    expect(screen.queryByTestId('config-policy-owner-trade')).toBeNull();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Front desk' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes()[0].body).toEqual({ name: 'Front desk', status: 'inactive', orgId: 'org-a' });
  });

  it('a limited partner must pick an organization when none is selected', async () => {
    authState.user = { permissions: [{ resource: 'devices', action: 'write' }], canManagePartnerWide: false };
    useOrgStore.setState({ currentOrgId: null });
    await renderCreate();
    expect(screen.getByTestId('config-policy-managed-by-select')).toHaveValue('');
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Front desk' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    expect(await screen.findByTestId('config-policy-owner-error')).toBeInTheDocument();
    expect(screen.queryByTestId('applies-to-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await act(async () => {});
    expect(writes()).toEqual([]);
    fireEvent.change(screen.getByTestId('config-policy-managed-by-select'), { target: { value: 'org-b' } });
    fireEvent.click(screen.getByTestId('patch-save'));
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes()[0].body).toEqual({ name: 'Front desk', status: 'inactive', orgId: 'org-b' });
  });

  it('an org-scope user gets their own organization, with no owner choice', async () => {
    claimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-b', partnerId: null } as never);
    useOrgStore.setState({ currentOrgId: 'org-b' });
    await renderCreate();
    expect(screen.queryByTestId('config-policy-managed-by-select')).toBeNull();
    expect(screen.getByTestId('config-policy-managed-by-fixed')).toHaveTextContent('Managed by Birch');
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Ours' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes()[0].body).toEqual({ name: 'Ours', status: 'inactive', orgId: 'org-b' });
  });

  it('a full-access partner can choose one organization instead', async () => {
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-managed-by-select'), { target: { value: 'org-b' } });
    expect(screen.queryByTestId('config-policy-owner-trade')).toBeNull();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Birch only' } });
    fireEvent.click(screen.getByTestId('config-policy-rail-tab-patch'));
    fireEvent.click(await screen.findByTestId('patch-save'));
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes()[0].body).toEqual({ name: 'Birch only', status: 'inactive', orgId: 'org-b' });
  });
});

describe('Activate with an explicit applies-to decision (C3)', () => {
  it('Activate on the create page opens the decision, staged, with the switcher org suggested', async () => {
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    const panel = await screen.findByTestId('applies-to-panel');
    expect(panel).toHaveAttribute('data-activation', 'true');
    expect(panel).toHaveAttribute('data-policy-id', 'null');
    expect(panel).toHaveAttribute('data-owner', 'msp');
    expect(panel).toHaveAttribute('data-suggested', 'org-a');
    expect(writes()).toEqual([]);
  });

  it('Activate creates, applies, then activates, in that order', async () => {
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toBe('ok'));
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /configuration-policies',
      `POST /configuration-policies/${NEW_ID}/assignments/apply`,
      `PATCH /configuration-policies/${NEW_ID}`,
    ]);
    expect(writes()[0].body).toMatchObject({ status: 'inactive' });
    expect(writes()[2].body).toEqual({ status: 'active' });
    await waitFor(() => expect(screen.queryByTestId('applies-to-panel')).toBeNull());
  });

  it('a failed apply leaves the policy inactive', async () => {
    mockApi({ apply: ok({ error: 'Target not allowed' }, 403) });
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toMatch(/stays inactive/));
    expect(writes().some((c) => c.method === 'PATCH')).toBe(false);
    expect(screen.getByTestId('applies-to-panel')).toBeInTheDocument();
  });

  it("Don't apply yet saves the policy inactive and applied nowhere", async () => {
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-dont-apply'));
    await waitFor(() => expect(document.body.getAttribute('data-dont-apply-result')).toBe('ok'));
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(['POST /configuration-policies']);
    expect(writes()[0].body).toMatchObject({ status: 'inactive' });
    await waitFor(() => expect(screen.queryByTestId('config-policy-create-header')).toBeNull());
  });

  it('Activate without a name creates nothing and says why', async () => {
    await renderCreate();
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toMatch(/Name the policy/));
    expect(writes()).toEqual([]);
  });
});

describe('Activate on an existing policy (C3)', () => {
  it('an inactive policy that applies nowhere asks for the decision; nothing is PATCHed', async () => {
    render(<ConfigPolicyDetailPage policyId={NEW_ID} />);
    fireEvent.click(await screen.findByTestId('config-policy-activate'));
    const panel = await screen.findByTestId('applies-to-panel');
    expect(panel).toHaveAttribute('data-activation', 'true');
    expect(panel).toHaveAttribute('data-policy-id', NEW_ID);
    expect(writes()).toEqual([]);
    // The existing policy is never created again.
    fireEvent.click(screen.getByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toBe('ok'));
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /configuration-policies/${NEW_ID}/assignments/apply`,
      `PATCH /configuration-policies/${NEW_ID}`,
    ]);
  });

  it('a policy that applies somewhere activates directly', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const res = await base(input, init);
      if (String(input) === `/configuration-policies/${NEW_ID}` && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET') {
        const body = await res.json();
        return ok({ ...body, appliesTo: { assignmentCount: 1, allOrganizations: true, targets: [], childPolicyCount: 0 } });
      }
      return res;
    });
    render(<ConfigPolicyDetailPage policyId={NEW_ID} />);
    fireEvent.click(await screen.findByTestId('config-policy-activate'));
    await waitFor(() => expect(writes().map((c) => c.method)).toEqual(['PATCH']));
    expect(screen.queryByTestId('applies-to-panel')).toBeNull();
  });
});

describe('Activate failure paths (review round)', () => {
  it('a refused activation after the targets applied says so and re-reads where the policy applies', async () => {
    mockApi({ patch: ok({ error: 'oem_updates_execute_required' }, 403) });
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-activate'));
    await waitFor(() =>
      expect(document.body.getAttribute('data-activate-result')).toMatch(/targets were applied, but the policy is still inactive/),
    );
    expect(writes()[1]).toMatchObject({
      url: `/configuration-policies/${NEW_ID}/assignments/apply`,
      body: { add: [{ level: 'organization', targetId: 'org-a', priority: 0 }], update: [], remove: [] },
    });
    // The page re-reads the policy (its targets changed) and stays inactive.
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'GET' && c.url === `/configuration-policies/${NEW_ID}`)).toBe(true),
    );
    expect(screen.getByTestId('applies-to-panel')).toBeInTheDocument();
  });

  it('a retry after a failed apply never creates a second policy', async () => {
    mockApi({ apply: ok({ error: 'Target not allowed' }, 403) });
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toMatch(/stays inactive/));
    document.body.removeAttribute('data-activate-result');
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/assignments/apply')) {
        calls.push({ url: String(input), method: 'POST', body: JSON.parse(String((init as RequestInit).body)) });
        return ok({ added: [{ id: 'a-1' }], updated: [], removed: [] }, 201);
      }
      return base(input, init);
    });
    fireEvent.click(screen.getByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toBe('ok'));
    expect(writes().filter((c) => c.url === '/configuration-policies' && c.method === 'POST')).toHaveLength(1);
    expect(writes().map((c) => `${c.method} ${c.url}`).slice(-2)).toEqual([
      `POST /configuration-policies/${NEW_ID}/assignments/apply`,
      `PATCH /configuration-policies/${NEW_ID}`,
    ]);
  });
});

describe('Start from: a parent that cannot be read (review round)', () => {
  it('says the parent features could not be read instead of showing none', async () => {
    const PARENT = '20000000-0000-4000-8000-0000000000cc';
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/configuration-policies/eligible-parents?ownerScope=partner') {
        return ok({ data: [{ id: PARENT, name: 'MSP baseline', ownerScope: 'partner' }] });
      }
      if (url === `/configuration-policies/${PARENT}`) return ok({ error: 'not found' }, 404);
      return base(input, init);
    });
    await renderCreate();
    expect(screen.queryByTestId('config-policy-parent-read-failed')).toBeNull();
    fireEvent.click(screen.getByTestId('config-policy-start-parent'));
    fireEvent.change(await screen.findByTestId('policy-link-selector'), { target: { value: PARENT } });
    expect(await screen.findByTestId('config-policy-parent-read-failed')).toHaveTextContent(/could not be read/);
    // Back to Blank clears it.
    fireEvent.click(screen.getByTestId('config-policy-start-blank'));
    await waitFor(() => expect(screen.queryByTestId('config-policy-parent-read-failed')).toBeNull());
  });
});

describe('Activate retry after a refused activation (review round)', () => {
  it('only activates: the applied targets are not sent again', async () => {
    mockApi({ patch: ok({ error: 'oem_updates_execute_required' }, 403) });
    await renderCreate();
    fireEvent.change(screen.getByTestId('config-policy-create-name'), { target: { value: 'Workstations' } });
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    fireEvent.click(await screen.findByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toMatch(/still inactive/));
    document.body.removeAttribute('data-activate-result');
    const before = writes().length;
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/configuration-policies/${NEW_ID}` && (init as RequestInit | undefined)?.method === 'PATCH') {
        calls.push({ url: String(input), method: 'PATCH', body: JSON.parse(String((init as RequestInit).body)) });
        return ok({ id: NEW_ID, status: 'active' });
      }
      return base(input, init);
    });
    fireEvent.click(screen.getByTestId('stub-activate'));
    await waitFor(() => expect(document.body.getAttribute('data-activate-result')).toBe('ok'));
    expect(writes().slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([`PATCH /configuration-policies/${NEW_ID}`]);
  });
});
