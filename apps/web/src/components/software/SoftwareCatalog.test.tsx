import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareCatalog from './SoftwareCatalog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// DeploymentWizard / SoftwareVersionManager / the deployments-tab components
// pull in their own fetches; stub them out so these tests exercise only the
// catalog's own logic. Probes echo the props we need to assert on.
vi.mock('./DeploymentWizard', () => ({
  default: (props: {
    initialCatalogId?: string;
    initialDeviceIds?: string[];
    onViewDeployment?: (id: string) => void;
  }) => (
    <div data-testid="wizard">
      wizard:{props.initialCatalogId ?? 'none'};devices:
      {(props.initialDeviceIds ?? []).join('|') || 'none'}
      <button
        type="button"
        data-testid="wizard-view-deployment"
        onClick={() => props.onViewDeployment?.('dep-42')}
      >
        view
      </button>
    </div>
  ),
}));
vi.mock('./SoftwareVersionManager', () => ({ default: () => null }));
vi.mock('./DeploymentList', () => ({
  default: (props: { onSelectDeployment?: (id: string) => void }) => (
    <div data-testid="deployment-list-probe">
      <button
        type="button"
        data-testid="select-deployment"
        onClick={() => props.onSelectDeployment?.('dep-7')}
      >
        select
      </button>
    </div>
  ),
}));
vi.mock('./DeploymentProgress', () => ({
  default: (props: { deploymentId: string; onBack?: () => void }) => (
    <div data-testid="deployment-progress-probe">
      progress:{props.deploymentId}
      <button type="button" data-testid="progress-back" onClick={() => props.onBack?.()}>
        back
      </button>
    </div>
  ),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const ITEM = {
  id: 'cat-1',
  orgId: 'org-1',
  name: 'TestApp',
  vendor: 'Acme',
  category: 'utility',
  description: 'A test package',
  createdAt: '2026-06-14T00:00:00Z'
};

describe('SoftwareCatalog delete', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
  });

  it('deletes a package via DELETE /software/catalog/:id and removes it from the list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [ITEM] })) // GET /software/catalog
      .mockResolvedValueOnce(jsonResponse({ success: true, id: ITEM.id })); // DELETE

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('TestApp')).toBeInTheDocument());

    fireEvent.click(screen.getByText('TestApp'));

    // Footer "Delete" opens the confirm modal.
    const deleteButtons = await screen.findAllByRole('button', { name: /Delete/ });
    fireEvent.click(deleteButtons[0]);

    expect(await screen.findByText('Delete package?')).toBeInTheDocument();

    // Confirm: the last "Delete" button is the one inside the confirm dialog.
    const confirmButtons = screen.getAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    // The item's own orgId must ride on the DELETE so a partner/system user in
    // "All organizations" mode (no ambient orgId injected by fetchWithAuth) can
    // still resolve which org's package to remove — otherwise the API answers
    // "orgId is required for this scope" (resolveScopedOrgId).
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith('/software/catalog/cat-1?orgId=org-1', { method: 'DELETE' })
    );

    // Success toast + item removed from the grid.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await waitFor(() => expect(screen.queryByText('TestApp')).not.toBeInTheDocument());
  });

  it('deletes an org-less (partner-scoped) package with no orgId query param', async () => {
    // A package the loader mapped with no orgId (DB org_id NULL) must DELETE to
    // the bare URL — appending ?orgId=undefined would break the request. Guards
    // against collapsing the conditional into an unconditional template.
    const { orgId, ...orgLessItem } = ITEM;
    void orgId;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [orgLessItem] })) // GET /software/catalog
      .mockResolvedValueOnce(jsonResponse({ success: true, id: ITEM.id })); // DELETE

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('TestApp')).toBeInTheDocument());

    fireEvent.click(screen.getByText('TestApp'));
    const deleteButtons = await screen.findAllByRole('button', { name: /Delete/ });
    fireEvent.click(deleteButtons[0]);
    expect(await screen.findByText('Delete package?')).toBeInTheDocument();

    const confirmButtons = screen.getAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith('/software/catalog/cat-1', { method: 'DELETE' })
    );
  });

  it('does not call the API when the delete is cancelled', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ITEM] }));

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('TestApp')).toBeInTheDocument());

    fireEvent.click(screen.getByText('TestApp'));
    const deleteButtons = await screen.findAllByRole('button', { name: /Delete/ });
    fireEvent.click(deleteButtons[0]);
    expect(await screen.findByText('Delete package?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Delete package?')).not.toBeInTheDocument());
    // Only the initial catalog GET happened — no DELETE.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Still present (in the card and the still-open detail modal).
    expect(screen.getAllByText('TestApp').length).toBeGreaterThan(0);
  });
});

const BUILTIN_ITEM = {
  id: 'builtin-huntress',
  name: 'Huntress EDR Agent',
  vendor: 'Huntress',
  category: 'security',
  description: 'Managed detection and response agent.',
  createdAt: '2026-06-26T00:00:00Z',
  integrationProvider: 'huntress',
  partnerId: 'partner-1'
};

/** Route the catalog + readiness fetches by URL so test order is robust. */
function routeBuiltin(items: unknown[], huntress?: unknown, s1?: unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/software/catalog') return Promise.resolve(jsonResponse({ data: items }));
    if (url.startsWith('/huntress/integration')) return Promise.resolve(jsonResponse({ data: huntress ?? null }));
    if (url.startsWith('/s1/integration')) return Promise.resolve(jsonResponse({ data: s1 ?? null }));
    return Promise.resolve(jsonResponse({ data: null }));
  });
}

const HUNTRESS_READY = { isActive: true, hasAccountKey: true, lastSyncOrgs: 2 };

describe('SoftwareCatalog built-in packages', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
  });

  it('renders a branded "Built-in" chip and a Ready pill for a ready Huntress package', async () => {
    routeBuiltin([BUILTIN_ITEM], HUNTRESS_READY);

    render(<SoftwareCatalog />);

    expect(await screen.findByText(/^Built-in$/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^Ready$/)).toBeInTheDocument());
    // The Huntress card no longer shows any installer-upload cue.
    expect(screen.queryByText(/Upload installer/i)).not.toBeInTheDocument();
  });

  it('opens the readiness detail panel (Managed built-in) with no Delete control', async () => {
    routeBuiltin([BUILTIN_ITEM], HUNTRESS_READY);

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('Huntress EDR Agent')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Huntress EDR Agent'));

    expect(await screen.findByText(/Managed built-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
  });

  it('surfaces the account-key next step in the detail panel when Huntress is incomplete', async () => {
    routeBuiltin([BUILTIN_ITEM], { isActive: true, hasAccountKey: false, lastSyncOrgs: 2 });

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('Huntress EDR Agent')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Huntress EDR Agent'));

    expect(await screen.findByText(/Next step: Account key configured/i)).toBeInTheDocument();
  });

  it('preselects the package into the deploy wizard when Deploy is clicked', async () => {
    routeBuiltin([BUILTIN_ITEM], HUNTRESS_READY);

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('Huntress EDR Agent')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Deploy$/ }));
    expect(await screen.findByTestId('wizard')).toHaveTextContent('wizard:builtin-huntress');
  });

  it('disables Deploy with an upload hint for a SentinelOne package that has no version', async () => {
    const s1NoVersion = {
      id: 'builtin-s1',
      name: 'SentinelOne Agent',
      vendor: 'SentinelOne',
      category: 'security',
      description: 'EDR agent.',
      createdAt: '2026-06-26T00:00:00Z',
      integrationProvider: 'sentinelone',
      partnerId: 'partner-1',
      versionCount: 0
    };
    routeBuiltin([s1NoVersion], undefined, { isActive: true });

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('SentinelOne Agent')).toBeInTheDocument());

    expect(screen.getByText(/Upload installer to enable deploy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Deploy$/ })).toBeDisabled();
  });

  it('enables Deploy for a SentinelOne package once a version is uploaded', async () => {
    const s1WithVersion = {
      id: 'builtin-s1b',
      name: 'SentinelOne Agent',
      vendor: 'SentinelOne',
      category: 'security',
      description: 'EDR agent.',
      createdAt: '2026-06-26T00:00:00Z',
      integrationProvider: 'sentinelone',
      partnerId: 'partner-1',
      versionCount: 1
    };
    routeBuiltin([s1WithVersion], undefined, { isActive: true });

    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('SentinelOne Agent')).toBeInTheDocument());

    expect(screen.queryByText(/Upload installer to enable deploy/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Deploy$/ })).not.toBeDisabled();
  });
});

const SUMMARY = { active: 2, scheduled: 1, completedLast7d: 3, failedLast7d: 4 };

/** Route catalog + summary fetches by URL so hash-driven mounts are order-robust. */
function routeDeployments() {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/software/catalog') return Promise.resolve(jsonResponse({ data: [ITEM] }));
    if (url === '/software/deployments/summary')
      return Promise.resolve(jsonResponse({ data: SUMMARY }));
    return Promise.resolve(jsonResponse({ data: null }));
  });
}

const setHash = (hash: string) =>
  window.history.replaceState(null, '', window.location.pathname + (hash ? `#${hash}` : ''));

describe('SoftwareCatalog deployments tab (hash-driven)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
    setHash('');
  });

  it('defaults to the catalog tab and switches to Deployments on tab click', async () => {
    routeDeployments();
    render(<SoftwareCatalog />);
    await waitFor(() => expect(screen.getByText('TestApp')).toBeInTheDocument());
    expect(screen.queryByTestId('deployment-list-probe')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('software-tab-deployments'));

    expect(await screen.findByTestId('deployment-list-probe')).toBeInTheDocument();
    expect(window.location.hash).toBe('#deployments');
    // Catalog grid is hidden while the Deployments tab is active.
    expect(screen.queryByText('TestApp')).not.toBeInTheDocument();
  });

  it('deep link #deployments renders summary cards and the deployment list', async () => {
    routeDeployments();
    setHash('deployments');
    render(<SoftwareCatalog />);

    expect(await screen.findByTestId('deployment-list-probe')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('deployment-summary-cards')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('deployment-summary-active')).toHaveTextContent('2');
    expect(screen.getByTestId('deployment-summary-scheduled')).toHaveTextContent('1');
    expect(screen.getByTestId('deployment-summary-completed-7d')).toHaveTextContent('3');
    expect(screen.getByTestId('deployment-summary-failed-7d')).toHaveTextContent('4');
  });

  it('deep link #deployment=<id> renders that deployment progress view; back returns to the list', async () => {
    routeDeployments();
    setHash('deployment=dep-7');
    render(<SoftwareCatalog />);

    expect(await screen.findByTestId('deployment-progress-probe')).toHaveTextContent(
      'progress:dep-7',
    );

    fireEvent.click(screen.getByTestId('progress-back'));
    expect(await screen.findByTestId('deployment-list-probe')).toBeInTheDocument();
    expect(window.location.hash).toBe('#deployments');
  });

  it('selecting a deployment in the list navigates to its progress view via the hash', async () => {
    routeDeployments();
    setHash('deployments');
    render(<SoftwareCatalog />);
    await screen.findByTestId('deployment-list-probe');

    fireEvent.click(screen.getByTestId('select-deployment'));

    expect(await screen.findByTestId('deployment-progress-probe')).toHaveTextContent(
      'progress:dep-7',
    );
    expect(window.location.hash).toBe('#deployment=dep-7');
  });

  it('consumes #deploy=<ids> (#2866): opens the wizard with the devices pre-selected and clears the hash', async () => {
    routeDeployments();
    setHash('deploy=dev-a,dev-b');
    render(<SoftwareCatalog />);

    const wizard = await screen.findByTestId('wizard');
    // No package preselected — the user picks it first; devices carried over.
    expect(wizard).toHaveTextContent('wizard:none');
    expect(wizard).toHaveTextContent('devices:dev-a|dev-b');
    // Hash consumed so a refresh doesn't re-open the wizard.
    expect(window.location.hash).toBe('');
  });

  it('wizard "View deployment" closes the modal and jumps to that deployment', async () => {
    routeDeployments();
    setHash('deploy=dev-a');
    render(<SoftwareCatalog />);
    await screen.findByTestId('wizard');

    fireEvent.click(screen.getByTestId('wizard-view-deployment'));

    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
    expect(await screen.findByTestId('deployment-progress-probe')).toHaveTextContent(
      'progress:dep-42',
    );
    expect(window.location.hash).toBe('#deployment=dep-42');
  });
});
