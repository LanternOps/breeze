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
