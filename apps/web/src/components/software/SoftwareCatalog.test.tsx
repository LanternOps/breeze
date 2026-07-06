import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareCatalog from './SoftwareCatalog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// DeploymentWizard / SoftwareVersionManager pull in their own fetches; stub them
// out so this test exercises only the catalog delete flow.
// Probe echoes the preselected package id so we can assert per-card deploy preselect.
vi.mock('./DeploymentWizard', () => ({
  default: (props: { initialCatalogId?: string }) => (
    <div data-testid="wizard">wizard:{props.initialCatalogId ?? 'none'}</div>
  ),
}));
vi.mock('./SoftwareVersionManager', () => ({ default: () => null }));

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

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith('/software/catalog/cat-1', { method: 'DELETE' })
    );

    // Success toast + item removed from the grid.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await waitFor(() => expect(screen.queryByText('TestApp')).not.toBeInTheDocument());
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
