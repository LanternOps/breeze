import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Stand in for the real tab editors so this suite stays focused on the
// page-level gating decision (which tab renders an editor vs. a read-only
// hint) rather than each tab's own fetch/save internals — those are covered
// by the tabs' own test files.
vi.mock('./featureTabs/PatchTab', () => ({
  default: () => <div data-testid="patch-tab-editor">Patch editor</div>,
}));
vi.mock('./featureTabs/BackupTab', () => ({
  default: () => <div data-testid="backup-tab-editor">Backup editor</div>,
}));
vi.mock('./AssignmentsTab', () => ({ default: () => <div data-testid="assignments-tab" /> }));

import ConfigPolicyDetailPage from './ConfigPolicyDetailPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function mockPolicy(owner: { orgId: string | null; partnerId: string | null }) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/configuration-policies/pol-1') {
      return json({
        id: 'pol-1',
        name: 'Test Policy',
        status: 'active',
        featureLinks: [],
        ...owner,
      });
    }
    if (url === '/configuration-policies/pol-1/features') {
      return json({ data: [] });
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gates the Backup tab (org-scoped-only) with an inline hint on a partner-wide policy, instead of the editor', async () => {
    mockPolicy({ orgId: null, partnerId: 'partner-1' });
    render(<ConfigPolicyDetailPage policyId="pol-1" />);

    await screen.findByRole('heading', { name: 'Test Policy' });
    openFeatureTab('Backup');

    expect(screen.queryByTestId('backup-tab-editor')).not.toBeInTheDocument();
    expect(screen.getByText(/isn't available on partner-wide policies/i)).toBeInTheDocument();
    expect(screen.getByText(/Configure this feature on an organization-scoped policy\./i)).toBeInTheDocument();
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

    expect(screen.getByText('Backup').closest('button')).toHaveAttribute(
      'title',
      expect.stringContaining('Not available on partner-wide policies')
    );
    // Patch tab isn't gated, so it shouldn't carry the hint tooltip.
    expect(screen.getByText('Patches').closest('button')).not.toHaveAttribute('title');
  });
});
