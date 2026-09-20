import { expect, test } from '@playwright/test';
import { TopologyPage } from '../pages/TopologyPage';
import { seedBaselineTopology } from '../helpers/topologyFixture';

/**
 * Production-browser acceptance for the `baseline-no-management` fixture.
 *
 * Runs against the BUILT Astro production server (see
 * `playwright.topology-worker.config.ts`), never the Vite dev server, so the
 * bundled module worker, the emitted asset URLs and the shipped CSP are the ones
 * under test. Every diagnostic reply is a controlled, canned response: no real
 * destination, resolver, CDN or production host is ever contacted.
 */

test('baseline map is useful and passive before explicit Diagnose', async ({ page }) => {
  const f = await seedBaselineTopology(page);
  const topology = new TopologyPage(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await topology.openNetworkDevice(f.ids.networkDeviceId);

  await topology.listToggle().click();
  await expect(topology.node(f.ids.gatewayNodeId)).toBeVisible();
  await expect(topology.node(f.ids.endpointNodeId)).toBeVisible();

  // Internet reachability is unknown until somebody asks for it.
  await expect(topology.internetHealth()).toHaveText('Not measured');

  // Nothing about opening, listing or selecting the map may start work.
  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
  expect(f.externalRequests()).toEqual([]);
  expect(errors).toEqual([]);
});

test('the published baseline is logical only: no physical links, peers hold membership alone', async ({ page }) => {
  const f = await seedBaselineTopology(page);
  const topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await topology.listToggle().click();

  // Guard against a vacuous "zero physical links": the site did publish edges.
  await expect(topology.relationshipsOfKind('network_member')).toHaveCount(3);
  await expect(topology.relationshipsOfKind('default_route')).toHaveCount(1);
  await expect(topology.relationshipsOfKind('egress_path')).toHaveCount(1);
  await expect(topology.relationshipsOfKind('physical_link')).toHaveCount(0);
  await expect(topology.relationshipsOfKind('attachment')).toHaveCount(0);

  // The default route's origin is the REPORTING endpoint, not the gateway.
  await expect(topology.edgeFrom(f.ids.defaultRouteEdgeId)).toHaveText('baseline-agent-01');
  await expect(topology.edgeTo(f.ids.defaultRouteEdgeId)).toHaveText('Reported gateway 192.0.2.1');

  // Each inventory peer touches exactly one relationship, and it is membership.
  for (const [edgeId, label] of [
    [f.ids.memberPeerAEdgeId, 'inventory-peer-a'],
    [f.ids.memberPeerBEdgeId, 'inventory-peer-b'],
  ] as const) {
    await expect(topology.edgeFrom(edgeId)).toHaveText(label);
    await expect(topology.edgeTo(edgeId)).toHaveText('192.0.2.0/24');
  }
  for (const peerNodeId of [f.ids.peerANodeId, f.ids.peerBNodeId]) {
    await topology.node(peerNodeId).click();
    await expect(topology.inspector()).toBeVisible();
    await topology.inspectorClose().click();
  }

  // Without a managed switch the physical view is not offered at all.
  const views = await topology.viewSelect().evaluate((element) =>
    [...(element as HTMLSelectElement).options].map((option) => [option.value, option.disabled]));
  expect(views).toContainEqual(['physical', true]);
  expect(views).toContainEqual(['overview', false]);
});

test('schematic identity stays presentation-only and is never diagnosable', async ({ page }) => {
  const f = await seedBaselineTopology(page);
  const topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await topology.listToggle().click();

  expect(f.ids.schematicNodeId.startsWith('presentation:')).toBe(true);
  expect(f.ids.schematicEdgeId.startsWith('presentation:')).toBe(true);
  await expect(topology.relationshipsOfKind('schematic')).toHaveCount(1);
  await expect(topology.nodesOfKind('schematic')).toHaveCount(1);

  await topology.node(f.ids.schematicNodeId).click();
  await expect(topology.inspector()).toBeVisible();
  // A schematic connector is an explanation, not an object you can probe.
  await expect(topology.diagnose()).toHaveCount(0);

  // A canonical node, by contrast, does offer the explicit action.
  await topology.inspectorClose().click();
  await topology.node(f.ids.gatewayNodeId).click();
  await expect(topology.diagnose()).toBeEnabled();

  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
});

test('a silent gateway stays "No ICMP response" and costs exactly one command', async ({ page }) => {
  const f = await seedBaselineTopology(page);
  const topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await topology.listToggle().click();
  await topology.selectFromList(f.ids.gatewayNodeId);

  expect((await f.effects()).commands).toBe(0);
  await topology.diagnose().click();
  await topology.runDiagnostic('gateway_basic');

  // Wait for the whole accepted plan to render before reading any step.
  await expect(topology.actualMethod()).toHaveCount(2);
  await expect(topology.actualMethod().first()).toHaveText('ROUTE_LOOKUP');
  await expect(topology.actualMethod().last()).toHaveText('ICMP');
  // The timeout is reported as an absence of response, not as a node failure.
  await expect(topology.diagnostics()).toContainText('No ICMP response');

  expect((await f.effects()).commands).toBe(1);
  expect(await f.effects()).toMatchObject({ schedules: 0, modelCalls: 0, layoutWrites: 0 });
  expect(f.externalRequests()).toEqual([]);
});

test('unconfigured targets refuse before any command, then configured targets attribute every hop', async ({ page }) => {
  const f = await seedBaselineTopology(page);
  const topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await topology.listToggle().click();
  await topology.selectFromList(f.ids.gatewayNodeId);
  await topology.diagnose().click();

  // 1. With nothing configured, the DNS and Internet recipes are refused.
  await topology.runDiagnostic('dns_basic');
  await expect(topology.diagnostics()).toContainText('Target not configured');
  await topology.runDiagnostic('internet_basic');
  await expect(topology.diagnostics()).toContainText('Target not configured');
  // A refused run registers no agent command, so nothing can leave the agent.
  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
  expect(f.externalRequests()).toEqual([]);

  // 2. Publish the controlled DNS target and two controlled HTTPS targets.
  f.configureTargets();

  await topology.runDiagnostic('dns_basic');
  await expect(topology.actualMethod()).toHaveCount(1);
  await expect(topology.diagnostics()).not.toContainText('Target not configured');
  await expect(topology.actualMethod().last()).toHaveText('DNS');
  await expect(topology.diagnostics()).toContainText('198.51.100.10');
  await expect(topology.diagnostics()).toContainText('ipv4');
  await expect(topology.diagnostics()).toContainText('default/eth0');
  expect((await f.effects()).commands).toBe(1);

  // 3. Two controlled HTTPS targets: a full DNS→TCP→TLS→HTTP chain plus one
  //    partial failure. The run degrades; it does not read as a total outage.
  await topology.runDiagnostic('target_connectivity');
  await expect(topology.actualMethod()).toHaveCount(5);
  expect(await topology.actualMethod().allTextContents()).toEqual(['DNS', 'TCP', 'TLS', 'HTTP', 'TCP']);
  await expect(topology.diagnostics()).toContainText('degraded');
  await expect(topology.diagnostics()).toContainText('failed_check');
  await expect(topology.diagnostics()).toContainText('198.51.100.20');

  expect((await f.effects()).commands).toBe(2);
  expect(await f.effects()).toMatchObject({ schedules: 0, modelCalls: 0, layoutWrites: 0 });
  expect(f.externalRequests()).toEqual([]);
});

test('every entry point reaches the same passive map', async ({ page }) => {
  const f = await seedBaselineTopology(page);
  const topology = new TopologyPage(page);

  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await expect(topology.internetHealth()).toHaveText('Not measured');

  await topology.openDevice(f.ids.deviceId);
  await expect(topology.internetHealth()).toHaveText('Not measured');

  await topology.openDiscovery(f.ids.siteId);
  await expect(topology.internetHealth()).toHaveText('Not measured');

  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
});
