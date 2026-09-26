import type { Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { TopologyPage } from '../pages/TopologyPage';
import { mutationRows, savedPositions, seedPhysicalTopology, type PhysicalTopologyFixture } from '../helpers/topologyPhysicalSeed';

/**
 * M2 physical enrichment against the REAL worktree stack (`pnpm wt-stack up`).
 *
 * The fixture is published through the production ingest routes and publisher
 * (see helpers/topologyPhysicalSeed.ts); the browser reads the real graph,
 * relationship-detail and evidence routes and runs the real layout worker. No
 * API route is mocked. DOM access is by data-testid only.
 */
test.describe.configure({ mode: 'serial' });

let fixture: PhysicalTopologyFixture;
test.beforeAll(() => { fixture = seedPhysicalTopology(); });

/**
 * Every non-GET API call the page makes, except the app shell's session upkeep
 * (token refresh under /auth and the realtime-events socket ticket). Any
 * discovery, diagnostic, AI, command, layout or topology write shows up here.
 */
const SESSION_UPKEEP = /^\/api\/v1\/(auth\/|events\/ws-ticket$)/;
function recordMutations(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' || !url.pathname.startsWith('/api/')) return;
    if (SESSION_UPKEEP.test(url.pathname)) return;
    seen.push(`${request.method()} ${url.pathname}`);
  });
  return seen;
}

test('the physical view shows measured ports, parallel cables and FDB directness, and stays passive', async ({ authedPage: page }) => {
  const mutations = recordMutations(page);
  const pinsBefore = savedPositions(fixture);
  const rowsBefore = mutationRows(fixture);
  expect(pinsBefore.length).toBeGreaterThanOrEqual(2);
  const topology = new TopologyPage(page);
  const r = fixture.relationships;

  await topology.openDiscoveryView(fixture.siteId, 'physical', fixture.orgId);
  await expect(topology.viewSelect()).toHaveValue('physical');
  await topology.showList();

  // Two parallel cables between the same switches stay two rows with their own ports.
  await topology.inspectRelationship(r.parallelA);
  await expect(topology.relationshipMeaning()).toContainText('Physical');
  await expect(topology.sourcePort()).toContainText(fixture.ports.parallelA);
  await expect(topology.targetPort()).toContainText(fixture.ports.parallelA);
  await expect(topology.evidenceMethod()).toHaveText('LLDP neighbor');
  await topology.inspectorClose().click();
  await topology.inspectRelationship(r.parallelB);
  await expect(topology.sourcePort()).toContainText(fixture.ports.parallelB);
  await expect(topology.targetPort()).toContainText(fixture.ports.parallelB);
  expect(fixture.ports.parallelA).not.toBe(fixture.ports.parallelB);
  await topology.inspectorClose().click();

  // FDB-only: learned through a port, never claimed as a direct cable.
  await topology.inspectRelationship(r.fdbOnly);
  await expect(topology.directness()).toHaveText('Direct connection not established');
  await expect(topology.portRole()).toHaveText('Learned through this port');
  await expect(topology.evidenceMethod()).toHaveText('Learned MAC address table (FDB)');
  await topology.inspectorClose().click();

  // Ambiguity is visible: the competing candidate lists the other one.
  await topology.inspectRelationship(r.competing[0]!);
  await expect(topology.alternatives()).toBeVisible();
  await topology.inspectorClose().click();

  // VPN is a remote-access association: an attachment row, never a cable or a radio link.
  await expect(topology.relationshipsOfKind('attachment').filter({ has: topology.edge(r.vpn) })).toHaveCount(1);
  await expect(topology.relationshipsOfKind('physical_link').filter({ has: topology.edge(r.vpn) })).toHaveCount(0);
  await topology.inspectRelationship(r.vpn);
  await expect(topology.association()).toHaveText('VPN or tunnel association');
  await expect(topology.directness()).toHaveText('Direct connection not established');
  await topology.inspectorClose().click();
  await topology.inspectRelationship(r.wireless);
  await expect(topology.association()).toHaveText('Wireless association (reported by controller)');
  await topology.inspectorClose().click();

  // Refetch: an explicit refresh re-reads, it never writes or probes.
  const refetched = page.waitForResponse((response) => response.url().includes('/graph') && response.request().method() === 'GET');
  await topology.refresh().click();
  await refetched;

  expect(mutations).toEqual([]);
  expect(mutationRows(fixture)).toBe(rowsBefore);
  expect(savedPositions(fixture)).toEqual(pinsBefore);
});

test('the overview keeps the saved pins byte-for-byte after physical enrichment', async ({ authedPage: page }) => {
  const mutations = recordMutations(page);
  const topology = new TopologyPage(page);
  const graphRead = page.waitForResponse((response) => /\/topology\/sites\/[^/]+\/graph\?/.test(response.url()) && response.url().includes('view=overview'));
  await topology.openDiscoveryView(fixture.siteId, 'overview', fixture.orgId);
  const body = await (await graphRead).json() as { layout: { positions: { nodeId: string; x: number; y: number; pinned: boolean }[] } };
  expect(body.layout.positions).toEqual(expect.arrayContaining([
    expect.objectContaining({ nodeId: fixture.nodes.agent, ...fixture.pins.agent, pinned: true }),
    expect.objectContaining({ nodeId: fixture.nodes.gateway, ...fixture.pins.gateway, pinned: true }),
  ]));
  await topology.showList();
  await topology.node(fixture.nodes.agent).click();
  await topology.inspector().waitFor();
  expect(mutations).toEqual([]);
});

test('light and dark, 390px wide, and keyboard-only list selection', async ({ authedPage: page }, testInfo) => {
  const mutations = recordMutations(page);
  const topology = new TopologyPage(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await topology.openDiscoveryView(fixture.siteId, 'physical', fixture.orgId);
    await topology.inspectRelationship(fixture.relationships.parallelA);
    await page.screenshot({ path: testInfo.outputPath(`topology-physical-${scheme}.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await topology.openDiscoveryView(fixture.siteId, 'physical', fixture.orgId);
  await topology.showList();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('topology-physical-390.png'), fullPage: true });

  // Keyboard only: focus a relationship row, open it with Enter, close with Escape.
  await topology.edge(fixture.relationships.fdbOnly).focus();
  await page.keyboard.press('Enter');
  await topology.inspector().waitFor();
  await expect(topology.directness()).toHaveText('Direct connection not established');
  await page.keyboard.press('Escape');
  await expect(topology.inspector()).toHaveCount(0);
  expect(mutations).toEqual([]);
});
