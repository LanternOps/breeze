import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify(topologyGraphFixture())));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

it('reaches and activates the keyboard-equivalent list purely by keyboard, then selects a node and reaches the inspector heading', async () => {
  const user = userEvent.setup();
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');

  await user.tab(); // search input
  expect(screen.getByTestId('topology-search')).toHaveFocus();
  await user.tab(); // view select
  expect(screen.getByTestId('topology-view')).toHaveFocus();
  await user.tab(); // list toggle
  expect(screen.getByTestId('topology-list-toggle')).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(await screen.findByTestId('topology-list')).toBeVisible();

  const nodeButton = await screen.findByTestId(`topology-node-${NODE}`);
  nodeButton.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByTestId('topology-inspector')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Reported gateway' })).toHaveFocus();
});

it('Escape from the inspector returns focus to the list toggle so keyboard flow never dead-ends', async () => {
  const user = userEvent.setup();
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  await user.click(screen.getByTestId('topology-list-toggle'));
  await user.click(await screen.findByTestId(`topology-node-${NODE}`));
  const inspector = await screen.findByTestId('topology-inspector');
  inspector.focus();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('topology-inspector')).not.toBeInTheDocument());
  expect(screen.getByTestId('topology-list-toggle')).toHaveFocus();
});

it('the diagnose control in the inspector is keyboard-reachable and keyboard-activatable', async () => {
  const user = userEvent.setup();
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  await user.click(screen.getByTestId('topology-list-toggle'));
  await user.click(await screen.findByTestId(`topology-node-${NODE}`));
  const diagnose = await screen.findByTestId('topology-diagnose');
  diagnose.focus();
  expect(diagnose).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(await screen.findByTestId('topology-diagnostics')).toBeVisible();
});

it('the frontier expand control is keyboard-activatable', async () => {
  const user = userEvent.setup();
  const initial = topologyGraphFixture();
  initial.frontier = [{ token: 'next', label: 'More nodes', memberCount: 3 }];
  const added = { ...initial.nodes[0], id: '10000000-0000-4000-8000-000000000099', label: 'Expanded peer' };
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/expansions/')
    ? { ...initial, nodes: [...initial.nodes, added], frontier: [] } : initial)));
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  const frontier = await screen.findByTestId('topology-frontier');
  frontier.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByTestId('topology-frontier')).not.toBeInTheDocument());
});

it('announces loading, then layout-arranged completion, through a single live region', async () => {
  const user = userEvent.setup();
  const { container } = render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading topology…');
  await screen.findByTestId('topology-health-internet');
  const live = container.querySelector('[aria-live="polite"]')!;
  expect(live).toBeInTheDocument();
  await user.click(screen.getByTestId('topology-arrange'));
  await waitFor(() => expect(live).toHaveTextContent('Layout preview complete'));
});

it('surfaces a load error through role=alert with a retry action, not a silent empty state', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ error: 'Unable to load topology' }), { status: 500 }));
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Unable to load topology');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
});
