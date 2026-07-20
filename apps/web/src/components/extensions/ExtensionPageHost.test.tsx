import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ExtensionPageHost from './ExtensionPageHost';

const findExtensionPage = vi.fn();
vi.mock('@/lib/extensions/registry', () => ({
  findExtensionPage: (...a: unknown[]) => findExtensionPage(...a),
}));

// ExtensionPageHost's own job is resolving the page + building the context
// contract; the element-mounting/error-boundary machinery is
// ExtensionElementHost's responsibility and has its own dedicated tests.
// Stub it here so these tests assert exactly the props it was handed.
vi.mock('./ExtensionElementHost', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="extension-element-host-stub" data-props={JSON.stringify(props)} />
  ),
}));

interface OrgScopeStub {
  ready: boolean;
  status: 'loading' | 'error' | 'empty' | 'resolved';
  scope: 'all' | 'org' | null;
  orgId: string | null;
  org: null;
  error: string | null;
}

let orgScope: OrgScopeStub = {
  ready: true,
  status: 'resolved',
  scope: 'org',
  orgId: 'org-1',
  org: null,
  error: null,
};

vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => orgScope,
  getOrgScope: () => orgScope,
}));

// OrgRequiredGate itself pulls the org list off this store for its
// fleet-view quick-pick UI — mock it so the gate never touches real state.
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: unknown[] }) => unknown) =>
    selector({ organizations: [] }),
}));

function resolvedOrgScope(orgId = 'org-1'): OrgScopeStub {
  return { ready: true, status: 'resolved', scope: 'org', orgId, org: null, error: null };
}

beforeEach(() => {
  findExtensionPage.mockReset();
  orgScope = resolvedOrgScope();
});

describe('ExtensionPageHost', () => {
  it('resolves the page and passes the ExtensionPageContextV1 contract down, sourcing organizationId from useOrgScope', async () => {
    findExtensionPage.mockResolvedValue({
      extension: {
        name: 'demo',
        version: '1.0.0',
        digest: 'abc123',
        moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
        pages: [],
        navigation: [],
        slots: [],
      },
      page: { id: 'main', path: '/dashboard', element: 'demo-dashboard' },
    });

    render(<ExtensionPageHost extensionName="demo" path="/dashboard" />);

    expect(await screen.findByTestId('extension-element-host-stub')).toBeInTheDocument();
    expect(findExtensionPage).toHaveBeenCalledWith('demo', '/dashboard');

    const props = JSON.parse(screen.getByTestId('extension-element-host-stub').dataset.props!);
    expect(props).toEqual({
      extensionName: 'demo',
      moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
      elementName: 'demo-dashboard',
      context: {
        contractVersion: 1,
        extensionName: 'demo',
        path: '/dashboard',
        organizationId: 'org-1',
      },
    });
  });

  it('renders the standard not-found state when the page is absent', async () => {
    findExtensionPage.mockResolvedValue(null);
    render(<ExtensionPageHost extensionName="demo" path="/missing" />);
    expect(await screen.findByTestId('extension-page-not-found')).toBeInTheDocument();
  });

  it('renders not-found (never the stale element) when the extension is disabled after navigation', async () => {
    // First mount: page resolves fine.
    findExtensionPage.mockResolvedValueOnce({
      extension: {
        name: 'demo', version: '1.0.0', digest: 'abc123',
        moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
        pages: [], navigation: [], slots: [],
      },
      page: { id: 'main', path: '/dashboard', element: 'demo-dashboard' },
    });
    const { unmount } = render(<ExtensionPageHost extensionName="demo" path="/dashboard" />);
    expect(await screen.findByTestId('extension-element-host-stub')).toBeInTheDocument();
    unmount();

    // A later navigation (fresh mount — Astro islands remount on navigation,
    // they don't rerender in place) re-resolves and finds the extension was
    // disabled server-side in the meantime.
    findExtensionPage.mockResolvedValueOnce(null);
    render(<ExtensionPageHost extensionName="demo" path="/dashboard" />);
    expect(await screen.findByTestId('extension-page-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-element-host-stub')).not.toBeInTheDocument();
  });

  it('renders not-found when the registry request fails (e.g. 401)', async () => {
    findExtensionPage.mockRejectedValue(new Error('extension registry request failed with status 401'));
    render(<ExtensionPageHost extensionName="demo" path="/dashboard" />);
    expect(await screen.findByTestId('extension-page-not-found')).toBeInTheDocument();
  });

  it('renders the org-required prompt instead of resolving a page when scope is fleet-wide (no org)', async () => {
    orgScope = { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null };
    render(<ExtensionPageHost extensionName="demo" path="/dashboard" />);
    expect(await screen.findByTestId('org-required-state')).toBeInTheDocument();
    expect(findExtensionPage).not.toHaveBeenCalled();
  });

  it('shows a loading skeleton before the registry lookup resolves', async () => {
    let resolvePage!: (v: unknown) => void;
    findExtensionPage.mockReturnValue(new Promise((resolve) => { resolvePage = resolve; }));
    render(<ExtensionPageHost extensionName="demo" path="/dashboard" />);
    expect(await screen.findByTestId('extension-page-skeleton')).toBeInTheDocument();
    resolvePage(null);
    await waitFor(() => expect(screen.getByTestId('extension-page-not-found')).toBeInTheDocument());
  });
});
