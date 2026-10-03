import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TopologyEntry from './TopologyEntry';
import { topologyApi, TopologyReadError } from './topologyApi';
import { useOrgStore } from '../../stores/orgStore';
import { clearTopologyPrefetch } from './topologyPrefetch';
import { topologySettingsFixture, SITE } from './topologyFixtures';

vi.mock('./topologyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./topologyApi')>();
  return { ...actual, topologyApi: { ...actual.topologyApi, settings: vi.fn(), graph: vi.fn(() => new Promise(() => {})), siteOwner: vi.fn() } };
});
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' }),
}));
vi.mock('./TopologyExplorer', () => ({ default: () => <div data-testid="topology-explorer" /> }));

const uiOff = (reason: string | null) => {
  const settings = topologySettingsFixture();
  settings.flags.ui = false;
  settings.capabilities.ui = { available: false, reason };
  return settings;
};

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { cleanup(); vi.clearAllMocks(); clearTopologyPrefetch(); useOrgStore.setState({ currentOrgId: null }); });

it('renders the empty state instead of the raw reason code when the ui capability is unavailable', async () => {
  vi.mocked(topologyApi.settings).mockResolvedValue(uiOff('materialization_disabled'));
  render(<TopologyEntry siteId={SITE} deviceId="device-1" />);
  const empty = await screen.findByTestId('topology-empty-state');
  expect(empty).toHaveTextContent('Network Topology is off');
  expect(screen.getByTestId('topology-entry').textContent).not.toContain('materialization_disabled');
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
});

it('keeps rendering the legacy node, not the empty state, when one is passed (DiscoveryPage)', async () => {
  vi.mocked(topologyApi.settings).mockResolvedValue(uiOff('materialization_disabled'));
  render(<TopologyEntry siteId={SITE} legacy={<div data-testid="legacy-map" />} />);
  expect(await screen.findByTestId('legacy-map')).toBeInTheDocument();
  expect(screen.queryByTestId('topology-empty-state')).toBeNull();
});

it('renders the explorer when the ui capability is available', async () => {
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  render(<TopologyEntry siteId={SITE} />);
  expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
  expect(screen.queryByTestId('topology-empty-state')).toBeNull();
});

const OTHER = '44444444-4444-4444-8444-444444444444';

it('never silently shows the current organization\'s site for a link to a site it does not own (#7880)', async () => {
  window.location.hash = `#topology/site/${OTHER}/view/overview`;
  vi.mocked(topologyApi.siteOwner).mockRejectedValue(new TopologyReadError('Access to this topology is denied', 403));
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} />);
  expect(await screen.findByTestId('topology-site-not-in-org')).toHaveTextContent('This site is not in the current organization');
  expect(topologyApi.siteOwner).toHaveBeenCalledWith(OTHER, expect.anything());
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
  expect(topologyApi.settings).not.toHaveBeenCalledWith(SITE, expect.anything());
  expect((screen.getByTestId('topology-site') as HTMLSelectElement).value).toBe('');
});

it('switches to the organization that owns a linked site when the user can open it (#7880)', async () => {
  window.location.hash = `#topology/site/${OTHER}/view/overview`;
  const selectOrganization = vi.fn();
  useOrgStore.setState({ currentOrgId: 'org-1', selectOrganization });
  vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: 'org-2' });
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  const view = render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} />);
  await waitFor(() => expect(selectOrganization).toHaveBeenCalledWith('org-2'));
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
  expect(screen.queryByTestId('topology-site-not-in-org')).toBeNull();
  // The owning org's site list arrives: the linked site opens.
  view.rerender(<TopologyEntry sites={[{ id: OTHER, name: 'Warehouse' }, { id: SITE, name: 'HQ' }]} />);
  expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
  expect(topologyApi.settings).toHaveBeenCalledWith(OTHER, expect.anything());
});

it('starts the topology settings and graph reads together instead of one after another (#7880)', async () => {
  vi.mocked(topologyApi.settings).mockReturnValue(new Promise(() => {}));
  render(<TopologyEntry siteId={SITE} />);
  await waitFor(() => expect(topologyApi.graph).toHaveBeenCalledTimes(1));
  expect(topologyApi.settings).toHaveBeenCalledTimes(1);
  const [site, query] = vi.mocked(topologyApi.graph).mock.calls[0]!;
  expect(site).toBe(SITE);
  expect(Object.fromEntries(query)).toEqual({ view: 'overview', includeHealth: 'true' });
});
