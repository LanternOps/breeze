import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TopologyExplorer from './TopologyExplorer';
import { topologyGraphFixture, topologySettingsFixture, SITE, NODE } from './topologyFixtures';
import { fetchWithAuth } from '../../stores/auth';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./TopologyCanvas', () => ({ default: () => <div data-testid="topology-canvas" /> }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
beforeEach(() => {
  window.location.hash = '#topology';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, options) => {
    if (options?.method === 'PATCH') return new Response(JSON.stringify({ error: 'Revision changed', code: 'revision_conflict' }), { status: 409 });
    return new Response(JSON.stringify(topologyGraphFixture()));
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });
it('renders a passive snapshot, and local arrangement never persists', async () => {
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  expect(await screen.findByTestId('topology-health-internet')).toHaveTextContent('Not measured');
  fireEvent.click(screen.getByTestId('topology-arrange'));
  await screen.findByTestId('topology-unsaved-layout');
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('provides keyboard-equivalent list inspection and preserves conflict drafts', async () => {
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  fireEvent.click(screen.getByTestId(`topology-node-${NODE}`));
  expect(await screen.findByTestId('topology-inspector')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Reported gateway' })).toHaveFocus();
  await screen.findByTestId('topology-unsaved-layout');
  fireEvent.click(screen.getByTestId('topology-layout-save'));
  expect(await screen.findByTestId('topology-layout-conflict')).toBeVisible();
  expect(screen.getByTestId('topology-unsaved-layout')).toBeVisible();
  fireEvent.keyDown(screen.getByTestId('topology-inspector'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByTestId('topology-inspector')).not.toBeInTheDocument());
  expect(screen.getByTestId('topology-list-toggle')).toHaveFocus();
});
it('read-only users can arrange but cannot save shared coordinates', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ ...topologyGraphFixture(), permissions: { canEdit: false, canDiagnose: false, canConfigureMonitoring: false } })));
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-arrange');
  expect(screen.queryByTestId('topology-layout-save')).not.toBeInTheDocument();
});

it('measures newly expanded nodes when the site graph revision is unchanged', async () => {
  const initial = topologyGraphFixture();
  const added = { ...initial.nodes[0], id: '10000000-0000-4000-8000-000000000099', label: 'Expanded peer' };
  initial.frontier = [{ token: 'next', label: 'More nodes', memberCount: 1 }];
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/expansions/')
    ? { ...initial, nodes: [...initial.nodes, added], frontier: [] } : initial)));
  const { container } = render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  fireEvent.click(await screen.findByTestId('topology-frontier'));
  await waitFor(() => expect(container.querySelector(`[data-node-id="${added.id}"]`)).toHaveTextContent('Expanded peer'));
});

it('enables the physical view from the capability and offers the overview from an empty physical view', async () => {
  const settings = topologySettingsFixture(); settings.capabilities.physical = { available: true, reason: null };
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('view=physical')
    ? { ...topologyGraphFixture(), view: 'physical', nodes: [], counts: { ...topologyGraphFixture().counts, totalNodes: 0, visibleNodes: 0 } } : topologyGraphFixture())));
  render(<TopologyExplorer siteId={SITE} settings={settings} />);
  await screen.findByTestId('topology-health-internet');
  const physical = screen.getByRole('option', { name: 'Physical' }) as HTMLOptionElement;
  expect(physical.disabled).toBe(false);
  fireEvent.change(screen.getByTestId('topology-view'), { target: { value: 'physical' } });
  fireEvent.click(await screen.findByTestId('topology-view-overview'));
  await waitFor(() => expect((screen.getByTestId('topology-view') as HTMLSelectElement).value).toBe('overview'));
});

it('lists connections hidden from the view and restores one through runAction', async () => {
  const relationshipId = '55555555-5555-4555-8555-555555555555';
  const exclusion = { id: '99999999-9999-4999-8999-999999999999', relationshipId, view: 'overview', reason: 'Lab bench cable', active: true,
    createdAt: '2026-09-26T10:00:00.000Z', createdBy: null, revokedAt: null, revokedBy: null,
    relationship: { id: relationshipId, kind: 'attachment', sourceNodeId: '11111111-1111-4111-8111-111111111111', targetNodeId: '22222222-2222-4222-8222-222222222222',
      sourceInterfaceId: null, targetInterfaceId: null, evidenceClass: 'inferred', lifecycle: 'active' } };
  vi.mocked(fetchWithAuth).mockImplementation(async (url, options) => {
    if (options?.method === 'DELETE') return new Response(JSON.stringify({ id: exclusion.id }));
    if (String(url).includes('/exclusions')) return new Response(JSON.stringify({ view: 'overview', graphRevision: '7', items: [exclusion], nextCursor: null }));
    return new Response(JSON.stringify(topologyGraphFixture()));
  });
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  expect(await screen.findByTestId(`topology-hidden-${exclusion.id}`)).toHaveTextContent('Lab bench cable');
  fireEvent.click(screen.getByTestId(`topology-restore-${exclusion.id}`));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(true));
  const [url] = vi.mocked(fetchWithAuth).mock.calls.find(([, options]) => options?.method === 'DELETE')!;
  expect(url).toBe(`/topology/sites/${SITE}/relationships/${exclusion.relationshipId}/exclusions/${exclusion.id}`);
});

it('takes diagnose and monitoring authority from the site settings, not the graph projection (M3 Task 11)', async () => {
  // The graph read reports canDiagnose/canConfigureMonitoring false by design; the
  // per-site settings read carries the real execute/configure + MFA answer.
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify({ ...topologyGraphFixture(), permissions: { canEdit: true, canDiagnose: false, canConfigureMonitoring: false } })));
  const settings = topologySettingsFixture();
  render(<TopologyExplorer siteId={SITE} settings={settings} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  fireEvent.click(screen.getByTestId(`topology-node-${NODE}`));
  expect(await screen.findByTestId('topology-diagnose')).toBeEnabled();
  cleanup();
  render(<TopologyExplorer siteId={SITE} settings={{ ...settings, permissions: { ...settings.permissions, canDiagnose: false } }} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  fireEvent.click(screen.getByTestId(`topology-node-${NODE}`));
  expect(await screen.findByTestId('topology-diagnose')).toBeDisabled();
});
