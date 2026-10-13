import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TopologyExplorer from './TopologyExplorer';
import { topologySettingsFixture, SITE } from './topologyFixtures';
import { groupedGraphFixture } from './groupedGraphFixture';
import { presenceAssigned, presenceDeviceId, presenceFixture, presenceVisitor } from './presenceFixtures';
import { fetchWithAuth } from '../../stores/auth';
import type { GraphResponse, PresenceResponse } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./TopologyCanvas', () => ({ default: () => <div data-testid="topology-canvas" /> }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const graph = (): GraphResponse => {
  const base = groupedGraphFixture([{ prefix: '10.1.5.0/24', declaration: 'declared', members: 2 }]);
  return { ...base, nodes: base.nodes.map((n, i) => i === 0 ? { ...n, bindings: [{ id: n.id, type: 'device' as const, referenceId: presenceDeviceId(1) }] } : n) };
};
/** Routes the graph and presence reads separately. `presence: null` answers /presence with a body that is not a presence response. */
const serve = (presence: PresenceResponse | null) => vi.mocked(fetchWithAuth).mockImplementation(async (url) => {
  if (String(url).includes('/presence')) return new Response(JSON.stringify(presence ?? graph()));
  return new Response(JSON.stringify(graph()));
});

beforeEach(() => {
  window.location.hash = '#topology';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

it('still renders the map when presence cannot be parsed', async () => {
  serve(null);
  render(<TopologyExplorer siteId={SITE} siteName="Lakeside" settings={topologySettingsFixture()} />);
  expect(await screen.findByTestId('topology-site-header')).toHaveTextContent('Lakeside');
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([url]) => String(url).endsWith('/presence'))).toBe(true));
  expect(screen.queryByTestId('topology-error')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/observed at other sites/)).toBeNull();
});

it('names how many devices are observed at other sites in the site header, and lists them in the roster', async () => {
  serve(presenceFixture({ siteId: SITE, assigned: [presenceAssigned(1)], counts: { observedElsewhere: 1, unidentified: 0, unknown: 0, visiting: 0 } }));
  render(<TopologyExplorer siteId={SITE} siteName="Lakeside" settings={topologySettingsFixture()} />);
  expect(await screen.findByTestId('topology-observed-elsewhere')).toHaveTextContent('1 observed at other sites');
  await userEvent.click(await screen.findByRole('button', { name: /Devices not on this site's networks \(1\)/ }));
  expect(screen.getByRole('region', { name: /^Observed at other sites/ })).toBeInTheDocument();
});

it('reaches a visitor through the keyboard-equivalent list, with its text alternative, and explains it in the inspector', async () => {
  const visitor = presenceVisitor(9, { label: 'LAPTOP-LOV-01' });
  serve(presenceFixture({ siteId: SITE, visitors: [visitor], counts: { observedElsewhere: 0, unidentified: 0, unknown: 0, visiting: 1 } }));
  render(<TopologyExplorer siteId={SITE} siteName="Lakeside" settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  await userEvent.click(screen.getByTestId('topology-list-toggle'));
  const row = await screen.findByTestId(`topology-node-${visitor.id}`);
  expect(row.closest('tr')).toHaveTextContent('Visiting device, assigned to Main Office');
  await userEvent.click(row);
  const inspector = await screen.findByTestId('topology-inspector');
  expect(within(inspector).getByRole('heading', { name: 'LAPTOP-LOV-01' })).toHaveFocus();
  expect(within(inspector).getByText("Assigned to Main Office. Reports Lakeside's network 10.1.5.0/24 via 10.1.5.1. The gateway matches Lakeside's devices.")).toBeVisible();
  expect(within(inspector).queryByTestId('topology-diagnose')).toBeNull();
  expect(within(inspector).queryByTestId('topology-pin')).toBeNull();
});

it('shows the ignored-declarations note only when entries were ignored', async () => {
  serve(presenceFixture({ siteId: SITE, ignoredDeclarations: 2 }));
  const { unmount } = render(<TopologyExplorer siteId={SITE} siteName="Lakeside" settings={topologySettingsFixture()} />);
  expect(await screen.findByTestId('topology-ignored-declarations')).toHaveTextContent('2 declared subnet entries were ignored (ranges, single addresses, IPv6 or unparsable text). Only exact IPv4 prefixes identify a site\'s networks.');
  unmount();
  serve(presenceFixture({ siteId: SITE, ignoredDeclarations: 0 }));
  render(<TopologyExplorer siteId={SITE} siteName="Lakeside" settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-site-header');
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.filter(([url]) => String(url).endsWith('/presence')).length).toBeGreaterThan(1));
  expect(screen.queryByTestId('topology-ignored-declarations')).toBeNull();
});

it('uses the singular for one ignored entry', async () => {
  serve(presenceFixture({ siteId: SITE, ignoredDeclarations: 1 }));
  render(<TopologyExplorer siteId={SITE} siteName="Lakeside" settings={topologySettingsFixture()} />);
  expect(await screen.findByTestId('topology-ignored-declarations')).toHaveTextContent('1 declared subnet entry was ignored');
});
