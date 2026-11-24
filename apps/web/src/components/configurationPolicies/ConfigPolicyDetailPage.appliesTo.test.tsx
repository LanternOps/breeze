import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Applies-to strip and drawer on the policy page (#12306). Split from
// ConfigPolicyDetailPage.test.tsx, which is already long; same mock setup.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // The page reads the org store, which registers with auth on import.
  registerOrgIdProvider: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { permissions: [{ resource: 'devices', action: 'write' }] } }),
}));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('../../lib/authScope', () => {
  const getJwtClaims = vi.fn(() => ({ scope: 'organization' as const, orgId: 'org-1', partnerId: null }));
  return {
    getJwtClaims,
    useJwtClaims: () => ({ status: 'resolved' as const, claims: getJwtClaims() }),
  };
});
vi.mock('./featureTabs/PatchTab', () => ({
  default: () => <div data-testid="patch-tab-editor">Patch editor</div>,
}));
vi.mock('./featureTabs/BackupTab', () => ({
  default: () => <div data-testid="backup-tab-editor">Backup editor</div>,
}));
const { panelProps } = vi.hoisted(() => ({ panelProps: { current: null as null | Record<string, any> } }));
vi.mock('./appliesTo/AppliesToPanel', () => ({
  default: (props: Record<string, any>) => {
    panelProps.current = props;
    return (
      <div data-testid="applies-to-panel">
        <button type="button" data-testid="stub-make-dirty" onClick={() => props.onDirtyChange(true)} />
        <button type="button" data-testid="stub-applied" onClick={() => props.onApplied()} />
      </div>
    );
  },
}));

import ConfigPolicyDetailPage from './ConfigPolicyDetailPage';
import { getJwtClaims } from '../../lib/authScope';
import { fetchWithAuth } from '../../stores/auth';
import { i18n } from '../../lib/i18n';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const appliesTo = {
  assignmentCount: 1,
  allOrganizations: false,
  targets: [
    { assignmentId: 'a-1', level: 'organization', targetId: 'org-1', name: 'Acme', roleFilter: null, osFilter: null },
  ],
  childPolicyCount: 0,
};

let reachResponse: () => Response = () => json({ direct: 12, throughChildren: 0, organizations: 1 });

function mockPolicy(extra: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (url === '/configuration-policies/pol-1' && method === 'GET') {
      return json({
        id: 'pol-1',
        name: 'Test Policy',
        status: 'active',
        orgId: 'org-1',
        partnerId: null,
        featureLinks: [],
        parentPolicyId: null,
        parentPolicy: null,
        childPolicies: [],
        appliesTo,
        ...extra,
      });
    }
    if (url === '/configuration-policies/pol-1/features' && method === 'GET') return json({ data: [] });
    if (url === '/configuration-policies/pol-1/reach' && method === 'GET') return reachResponse();
    return json({ error: 'not found' }, false);
  });
}

const policyGets = () =>
  fetchMock.mock.calls.filter(
    (c) => c[0] === '/configuration-policies/pol-1' && ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  ).length;

// Select a feature the way a user does: its rail item.
const FEATURE_KEYS: Record<string, string> = { Patches: 'patch', Backup: 'backup' };
function openFeatureTab(label: string) {
  fireEvent.click(screen.getByTestId(`config-policy-rail-tab-${FEATURE_KEYS[label]}`));
}

describe('ConfigPolicyDetailPage — Applies-to strip and drawer (#12306)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    panelProps.current = null;
    vi.mocked(getJwtClaims).mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null } as never);
    reachResponse = () => json({ direct: 12, throughChildren: 0, organizations: 1 });
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('the rail has no Assignments entry', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    expect(screen.queryByText('Assignments')).toBeNull();
    expect(screen.queryByTestId('config-policy-rail-tab-assignments')).toBeNull();
  });

  it('renders the strip from appliesTo above the feature rail', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    const strip = await screen.findByTestId('config-policy-applies-to-strip');
    expect(strip).toHaveTextContent('Acme');
    const rail = screen.getByRole('navigation', { name: 'Policy features' });
    expect(strip.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the strip stays visible on a feature tab', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Patches');
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-applies-to-strip')).toHaveTextContent('Acme');
  });

  it('#assignments opens the Applies-to drawer', async () => {
    window.location.hash = '#assignments';
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    const drawer = await screen.findByTestId('config-policy-applies-to-drawer');
    expect(drawer).toHaveTextContent('Applies to');
    expect(screen.getByTestId('applies-to-panel')).toBeInTheDocument();
    // The alias is canonicalized away and the page stays on the first feature.
    await waitFor(() => expect(window.location.hash).toBe('#patch'));
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
  });

  it('#assignments set while on a feature tab opens the drawer and keeps that tab', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Patches');
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    act(() => {
      window.location.hash = '#assignments';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('config-policy-applies-to-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('patch-tab-editor')).toBeInTheDocument();
    expect(window.location.hash).toBe('#patch');
  });

  it('a detail read without appliesTo claims nothing', async () => {
    mockPolicy({ appliesTo: undefined });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    const strip = await screen.findByTestId('config-policy-applies-to-strip');
    expect(strip).toHaveTextContent('—');
    expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
    expect(screen.queryByTestId('config-policy-applies-to-in-use')).toBeNull();
  });

  it('the drawer renders the applies-to panel', async () => {
    mockPolicy({ orgName: 'Acme' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-edit'));
    expect(await screen.findByTestId('applies-to-panel')).toBeInTheDocument();
    expect(panelProps.current).toMatchObject({
      policyId: 'pol-1',
      owner: { kind: 'org', orgId: 'org-1', orgName: 'Acme' },
      summary: { assignmentCount: 1 },
    });
    await waitFor(() => expect(panelProps.current?.reach).toEqual({ direct: 12, throughChildren: 0, organizations: 1 }));
  });

  it('an MSP-managed policy opens the panel as MSP-managed', async () => {
    // A partner caller: an org caller would get the read-only view.
    vi.mocked(getJwtClaims).mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' } as never);
    mockPolicy({ orgId: null, partnerId: 'p-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-edit'));
    await screen.findByTestId('applies-to-panel');
    expect(panelProps.current?.owner).toEqual({ kind: 'msp' });
  });

  it('a dirty draft blocks closing the drawer', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-edit'));
    fireEvent.click(await screen.findByTestId('stub-make-dirty'));
    expect(screen.getByTestId('config-policy-applies-to-drawer-close')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Apply or discard your changes first.')).toBeInTheDocument();
  });

  it('an Apply re-reads the policy and its reach', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-edit'));
    await screen.findByTestId('applies-to-panel');
    const reachGets = () => fetchMock.mock.calls.filter((c) => c[0] === '/configuration-policies/pol-1/reach').length;
    await waitFor(() => expect(reachGets()).toBe(1));
    const before = policyGets();
    fireEvent.click(screen.getByTestId('stub-applied'));
    await waitFor(() => expect(policyGets()).toBe(before + 1));
    await waitFor(() => expect(reachGets()).toBe(2));
    // The drawer stays open after an Apply.
    expect(screen.getByTestId('applies-to-panel')).toBeInTheDocument();
  });

  it('a slow first reach that answers after the post-Apply one does not overwrite it', async () => {
    const pending: Array<(r: Response) => void> = [];
    reachResponse = () => undefined as unknown as Response;
    mockPolicy();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input) === '/configuration-policies/pol-1/reach'
        ? new Promise<Response>((resolve) => { pending.push(resolve); })
        : base(input, init));
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-edit'));
    await screen.findByTestId('applies-to-panel');
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByTestId('stub-applied'));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!(json({ direct: 7, throughChildren: 0, organizations: 1 })));
    await act(async () => pending[0]!(json({ direct: 12, throughChildren: 0, organizations: 1 })));
    expect(panelProps.current?.reach).toEqual({ direct: 7, throughChildren: 0, organizations: 1 });
  });

  it('the strip shows the reach count', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    expect(await screen.findByTestId('config-policy-applies-to-reach')).toHaveTextContent('12 devices');
  });

  it('a reach failure leaves the counts out and the page usable', async () => {
    reachResponse = () => json({ error: 'boom' }, false);
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByTestId('config-policy-applies-to-target');
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/configuration-policies/pol-1/reach')).toBe(true));
    expect(screen.queryByTestId('config-policy-applies-to-reach')).toBeNull();
    fireEvent.click(screen.getByTestId('config-policy-applies-to-edit'));
    expect(await screen.findByTestId('applies-to-panel')).toBeInTheDocument();
    expect(panelProps.current?.reach).toBeNull();
  });

  it('the Edit button opens the drawer', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-edit'));
    expect(await screen.findByTestId('config-policy-applies-to-drawer')).toBeInTheDocument();
  });

  it('closing the drawer refetches the policy and keeps the open feature tab mounted', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Patches');
    const editor = screen.getByTestId('patch-tab-editor');
    const before = policyGets();
    fireEvent.click(screen.getByTestId('config-policy-applies-to-edit'));
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-drawer-close'));
    await waitFor(() => expect(policyGets()).toBe(before + 1));
    // A silent refresh: no spinner swap, so the same editor node survives.
    expect(screen.getByTestId('patch-tab-editor')).toBe(editor);
    await waitFor(() => expect(screen.queryByTestId('config-policy-applies-to-drawer')).toBeNull());
  });

  it('saving details goes through runAction and keeps Based on and the strip', async () => {
    const parentPolicy = { id: 'parent-1', name: 'Baseline', status: 'active', orgId: 'org-1', featureLinks: [] };
    const full = {
      id: 'pol-1',
      name: 'Test Policy',
      status: 'active',
      orgId: 'org-1',
      partnerId: null,
      featureLinks: [],
      parentPolicyId: 'parent-1',
      parentPolicy,
      childPolicies: [],
      appliesTo,
    };
    let patchOk = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/configuration-policies/pol-1' && method === 'GET') return json(full);
      if (url === '/configuration-policies/pol-1' && method === 'PATCH') {
        if (!patchOk) return json({ error: 'Name already taken' }, false);
        // The PATCH answers with the bare row: no parentPolicy, no summary.
        return json({ id: 'pol-1', name: 'Test Policy', status: 'active', orgId: 'org-1', partnerId: null, parentPolicyId: 'parent-1' });
      }
      if (url === '/configuration-policies/pol-1/features' && method === 'GET') return json({ data: [] });
      return json({ error: 'not found' }, false);
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByTestId('config-policy-edit-details'));

    // A failed save toasts through runAction.
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Name already taken' })),
    );

    patchOk = true;
    const before = policyGets();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(policyGets()).toBe(before + 1));
    // A saved form closes.
    expect(screen.queryByTestId('config-policy-details-form')).toBeNull();
    openFeatureTab('Backup');
    expect(screen.getByTestId('config-policy-based-on')).toHaveTextContent('Baseline');
    expect(screen.getByTestId('config-policy-applies-to-strip')).toHaveTextContent('Acme');
  });

  it('a failed re-read after the drawer closes drops the old summary instead of keeping it', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    expect(await screen.findByTestId('config-policy-applies-to-strip')).toHaveTextContent('Acme');
    fetchMock.mockImplementation(async () => json({ error: 'boom' }, false));
    fireEvent.click(screen.getByTestId('config-policy-applies-to-edit'));
    fireEvent.click(await screen.findByTestId('config-policy-applies-to-drawer-close'));
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })),
    );
    const strip = screen.getByTestId('config-policy-applies-to-strip');
    expect(strip).not.toHaveTextContent('Acme');
    expect(strip).toHaveTextContent('—');
    expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
  });

  it('a saved name shows even when the re-read after the save fails', async () => {
    let patched = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/configuration-policies/pol-1' && method === 'PATCH') {
        patched = true;
        return json({ id: 'pol-1', name: 'Renamed', status: 'active' });
      }
      if (url === '/configuration-policies/pol-1' && method === 'GET') {
        if (patched) throw new TypeError('network down');
        return json({
          id: 'pol-1', name: 'Test Policy', status: 'active', orgId: 'org-1', partnerId: null,
          featureLinks: [], parentPolicyId: null, parentPolicy: null, childPolicies: [], appliesTo,
        });
      }
      if (url === '/configuration-policies/pol-1/features' && method === 'GET') return json({ data: [] });
      return json({ error: 'not found' }, false);
    });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByTestId('config-policy-edit-details'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
  });
});
