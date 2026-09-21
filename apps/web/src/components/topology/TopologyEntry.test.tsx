import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TopologyEntry from './TopologyEntry';
import { topologyApi } from './topologyApi';
import { topologySettingsFixture, SITE } from './topologyFixtures';

vi.mock('./topologyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./topologyApi')>();
  return { ...actual, topologyApi: { ...actual.topologyApi, settings: vi.fn() } };
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
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
