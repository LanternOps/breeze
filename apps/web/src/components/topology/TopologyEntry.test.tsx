import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopologyEntry from './TopologyEntry';
import { topologyApi, TopologyReadError } from './topologyApi';
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
// Renders whatever start-of-toolbar control the entry hands it, so a test sees where the site select lives.
vi.mock('./TopologyExplorer', () => ({ default: ({ toolbarStart }: { toolbarStart?: ReactNode }) => <div data-testid="topology-explorer">{toolbarStart}</div> }));

const uiOff = (reason: string | null) => {
  const settings = topologySettingsFixture();
  settings.flags.ui = false;
  settings.capabilities.ui = { available: false, reason };
  return settings;
};

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { cleanup(); vi.clearAllMocks(); clearTopologyPrefetch(); });

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
  const organization = { currentOrgId: 'org-1', selectOrganization };
  vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: 'org-2' });
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  const view = render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} organization={organization} />);
  await waitFor(() => expect(selectOrganization).toHaveBeenCalledWith('org-2'));
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
  expect(screen.queryByTestId('topology-site-not-in-org')).toBeNull();
  // The owning org's site list arrives: the linked site opens.
  view.rerender(<TopologyEntry sites={[{ id: OTHER, name: 'Warehouse' }, { id: SITE, name: 'HQ' }]} organization={organization} />);
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

it('a failed site lookup (not 403/404) is a load error, not "not in this organization" (#7880 review)', async () => {
  window.location.hash = `#topology/site/${OTHER}/view/overview`;
  vi.mocked(topologyApi.siteOwner).mockRejectedValue(new TopologyReadError('Unable to load topology', 503));
  render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} />);
  expect(await screen.findByTestId('topology-site-lookup-failed')).toHaveTextContent('Unable to load topology');
  expect(screen.queryByTestId('topology-site-not-in-org')).toBeNull();
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
});

it('opens a linked site that is the organization\'s only site (the first-commit guard must not block it)', async () => {
  window.location.hash = `#topology/site/${SITE}/view/overview`;
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} />);
  expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
  expect(topologyApi.settings).toHaveBeenCalledTimes(1);
  expect(topologyApi.siteOwner).not.toHaveBeenCalled();
});

it('a same-org link waits for the site list, then opens the site with the reads it started early (#7880)', async () => {
  const org = '55555555-5555-4555-8555-555555555555';
  window.location.hash = `#topology/site/${OTHER}/view/overview`;
  const organization = { currentOrgId: org, selectOrganization: vi.fn() };
  vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: org });
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  const view = render(<TopologyEntry sites={[]} organization={organization} />);
  await waitFor(() => expect(topologyApi.settings).toHaveBeenCalledWith(OTHER));
  expect(topologyApi.graph).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('topology-site-not-in-org')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Loading topology');
  view.rerender(<TopologyEntry sites={[{ id: OTHER, name: 'Warehouse' }]} organization={organization} />);
  expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
  expect(topologyApi.settings).toHaveBeenCalledTimes(1);
});

it('says the site is not in this organization when its owner is the current org but the loaded list lacks it', async () => {
  const org = '55555555-5555-4555-8555-555555555555';
  window.location.hash = `#topology/site/${OTHER}/view/overview`;
  const organization = { currentOrgId: org, selectOrganization: vi.fn() };
  vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: org });
  render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} organization={organization} />);
  expect(await screen.findByTestId('topology-site-not-in-org')).toBeInTheDocument();
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
});


it('without an organization selector, a linked site owned by another organization is reported, never switched to or shown', async () => {
  window.location.hash = `#topology/site/${OTHER}/view/overview`;
  vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: '66666666-6666-4666-8666-666666666666' });
  render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} />);
  expect(await screen.findByTestId('topology-site-not-in-org')).toBeInTheDocument();
  expect(screen.queryByTestId('topology-explorer')).toBeNull();
});

it('keeps keyboard focus on the site select when the site changes (the select never remounts)', async () => {
  window.location.hash = `#topology/site/${SITE}/view/overview`;
  vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
  render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }, { id: OTHER, name: 'Warehouse' }]} />);
  await screen.findByTestId('topology-explorer');
  const select = screen.getByTestId('topology-site') as HTMLSelectElement;
  select.focus();
  expect(document.activeElement).toBe(select);
  // ArrowDown on a closed select fires `change` straight away.
  fireEvent.change(select, { target: { value: OTHER } });
  await waitFor(() => expect(topologyApi.settings).toHaveBeenCalledWith(OTHER, expect.anything()));
  expect(document.activeElement).toBe(screen.getByTestId('topology-site'));
  expect(screen.getByTestId('topology-site')).toBe(select);
  await screen.findByTestId('topology-explorer');
  expect(document.activeElement).toBe(select);
  expect(screen.getAllByTestId('topology-site')).toHaveLength(1);
});

describe('an org switch after a site link has been applied (#8113)', () => {
  const ORG_A = '77777777-7777-4777-8777-777777777777', ORG_B = '88888888-8888-4888-8888-888888888888', ORG_C = '99999999-9999-4999-8999-999999999999';

  it('the user\'s org switch wins: the link is not re-resolved, the selector is not moved back, and the site leaves the hash', async () => {
    window.location.hash = `#topology/site/${OTHER}/view/logical`;
    const selectOrganization = vi.fn();
    vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: ORG_B });
    vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
    const view = render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} organization={{ currentOrgId: ORG_A, selectOrganization }} />);
    // The link moves the selector to the site's organization once (#7882)...
    await waitFor(() => expect(selectOrganization).toHaveBeenCalledWith(ORG_B));
    view.rerender(<TopologyEntry sites={[]} organization={{ currentOrgId: ORG_B, selectOrganization }} />);
    view.rerender(<TopologyEntry sites={[{ id: OTHER, name: 'Warehouse' }]} organization={{ currentOrgId: ORG_B, selectOrganization }} />);
    expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
    const lookups = vi.mocked(topologyApi.siteOwner).mock.calls.length;
    // ...then the user picks another organization (the store empties the site list in the same update).
    view.rerender(<TopologyEntry sites={[]} organization={{ currentOrgId: ORG_C, selectOrganization }} />);
    await waitFor(() => expect(window.location.hash).toBe('#topology/view/logical'));
    view.rerender(<TopologyEntry sites={[{ id: SITE, name: 'Branch' }]} organization={{ currentOrgId: ORG_C, selectOrganization }} />);
    await waitFor(() => expect(topologyApi.settings).toHaveBeenCalledWith(SITE, expect.anything()));
    expect(selectOrganization).toHaveBeenCalledTimes(1);
    expect(topologyApi.siteOwner).toHaveBeenCalledTimes(lookups);
    expect(screen.queryByTestId('topology-site-not-in-org')).toBeNull();
  });

  it('a switch made while the link\'s owner lookup is still in flight also wins (no late snap-back)', async () => {
    window.location.hash = `#topology/site/${OTHER}/view/logical`;
    const selectOrganization = vi.fn();
    let answer!: (owner: { id: string; orgId: string }) => void;
    vi.mocked(topologyApi.siteOwner).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const view = render(<TopologyEntry sites={[]} organization={{ currentOrgId: ORG_A, selectOrganization }} />);
    await waitFor(() => expect(topologyApi.siteOwner).toHaveBeenCalledTimes(1));
    view.rerender(<TopologyEntry sites={[]} organization={{ currentOrgId: ORG_C, selectOrganization }} />);
    await waitFor(() => expect(window.location.hash).toBe('#topology/view/logical'));
    answer({ id: OTHER, orgId: ORG_B });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selectOrganization).not.toHaveBeenCalled();
    expect(topologyApi.siteOwner).toHaveBeenCalledTimes(1);
  });

  it('the store selecting its first organization while a link resolves (fresh session) is not a user switch', async () => {
    window.location.hash = `#topology/site/${OTHER}/view/overview`;
    const selectOrganization = vi.fn();
    vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: ORG_B });
    const view = render(<TopologyEntry sites={[]} organization={{ currentOrgId: null, selectOrganization }} />);
    view.rerender(<TopologyEntry sites={[]} organization={{ currentOrgId: ORG_A, selectOrganization }} />);
    await waitFor(() => expect(selectOrganization).toHaveBeenCalledWith(ORG_B));
    expect(window.location.hash).toBe(`#topology/site/${OTHER}/view/overview`);
  });

  it('a site picked from this organization\'s list is dropped, not chased, when the user switches organization', async () => {
    window.location.hash = `#topology/site/${OTHER}/view/overview`;
    const selectOrganization = vi.fn();
    vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
    const view = render(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }, { id: OTHER, name: 'Warehouse' }]} organization={{ currentOrgId: ORG_A, selectOrganization }} />);
    expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
    view.rerender(<TopologyEntry sites={[]} organization={{ currentOrgId: ORG_B, selectOrganization }} />);
    await waitFor(() => expect(window.location.hash).toBe('#topology/view/overview'));
    expect(topologyApi.siteOwner).not.toHaveBeenCalled();
    expect(selectOrganization).not.toHaveBeenCalled();
  });

  it('a new link opened after the switch is resolved again (once per link, not once per page)', async () => {
    window.location.hash = `#topology/site/${OTHER}/view/overview`;
    const selectOrganization = vi.fn();
    vi.mocked(topologyApi.settings).mockResolvedValue(topologySettingsFixture());
    const view = render(<TopologyEntry sites={[{ id: OTHER, name: 'Warehouse' }]} organization={{ currentOrgId: ORG_A, selectOrganization }} />);
    expect(await screen.findByTestId('topology-explorer')).toBeInTheDocument();
    view.rerender(<TopologyEntry sites={[{ id: SITE, name: 'HQ' }]} organization={{ currentOrgId: ORG_B, selectOrganization }} />);
    await waitFor(() => expect(window.location.hash).toBe('#topology/view/overview'));
    vi.mocked(topologyApi.siteOwner).mockResolvedValue({ id: OTHER, orgId: ORG_A });
    window.location.hash = `#topology/site/${OTHER}/view/overview`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(selectOrganization).toHaveBeenCalledWith(ORG_A));
  });
});
