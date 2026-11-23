import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Applies-to strip and drawer on the policy page (#12306). Split from
// ConfigPolicyDetailPage.test.tsx, which is already long; same mock setup.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
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
vi.mock('./AssignmentsTab', () => ({ default: () => <div data-testid="assignments-tab" /> }));

import ConfigPolicyDetailPage from './ConfigPolicyDetailPage';
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
    return json({ error: 'not found' }, false);
  });
}

const policyGets = () =>
  fetchMock.mock.calls.filter(
    (c) => c[0] === '/configuration-policies/pol-1' && ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  ).length;

// jsdom reports zero widths, so every tab past Overview sits in "More".
function openFeatureTab(label: string) {
  fireEvent.click(screen.getByText('More'));
  fireEvent.click(screen.getByText(label));
}

describe('ConfigPolicyDetailPage — Applies-to strip and drawer (#12306)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('the tab strip no longer contains Assignments', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    await screen.findByRole('heading', { name: 'Test Policy' });
    fireEvent.click(screen.getByText('More'));
    expect(screen.queryByRole('tab', { name: /Assignments/i })).toBeNull();
    expect(screen.queryByText('Assignments')).toBeNull();
  });

  it('renders the strip from appliesTo above the tabs', async () => {
    mockPolicy();
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    const strip = await screen.findByTestId('config-policy-applies-to-strip');
    expect(strip).toHaveTextContent('Acme');
    const tablist = screen.getByRole('tablist');
    expect(strip.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(screen.getByTestId('assignments-tab')).toBeInTheDocument();
    // The alias is canonicalized away and the page stays on Overview.
    await waitFor(() => expect(window.location.hash).not.toBe('#assignments'));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
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

  it('saving details goes through runAction and keeps the parent banner', async () => {
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

    // A failed save toasts through runAction.
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Name already taken' })),
    );

    patchOk = true;
    const before = policyGets();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(policyGets()).toBe(before + 1));
    openFeatureTab('Backup');
    expect(screen.getByText('Baseline')).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
  });
});
