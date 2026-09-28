import type { Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { TopologyOperationsPage } from '../pages/TopologyOperationsPage';
import {
  operationsMutationRows, policyState, seedOperationsTopology, telemetryArmStates, type TopologyOperationsFixture,
} from '../helpers/topologyOperationsSeed';

/**
 * M3 operational inspector against the REAL worktree stack (`pnpm wt-stack up`).
 *
 * The seed publishes the M2 physical fixture through the production ingest
 * routes, then stores SNMP interface samples on one port and a site policy with
 * activation intent (helpers/topologyOperationsSeed.ts). The browser drives the
 * real link-health, history, impact, change, monitoring and arming routes. No
 * API route is mocked; DOM access is by data-testid only.
 *
 * The stack runs with ENABLE_2FA=false (no enrolled factor for the seeded
 * admin), so the `topology_arm` step-up is not exercised here; its
 * server-driven prompt is covered by MonitoringPolicyPanel.test.tsx.
 */
test.describe.configure({ mode: 'serial' });

let fixture: TopologyOperationsFixture;
test.beforeAll(() => { fixture = seedOperationsTopology(); });

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

async function openLink(topology: TopologyOperationsPage) {
  await topology.openDiscoveryView(fixture.siteId, 'physical', fixture.orgId);
  await topology.showList();
  await topology.edge(fixture.link).click();
  await topology.inspector().waitFor();
}

test('link health, port history, impact and changes are passive reads with honest gaps', async ({ authedPage: page }) => {
  const mutations = recordMutations(page);
  const rowsBefore = operationsMutationRows(fixture);
  const topology = new TopologyOperationsPage(page);
  await openLink(topology);

  // Link health: the measured source port is described by its own measurement.
  await expect(topology.linkHealth()).toBeVisible();
  await expect(topology.endpoint('source')).toContainText(fixture.port.name ?? '');
  await expect(topology.freshness()).not.toBeEmpty();

  // Port history: previous generation separate, the collection gap visible, a measured zero kept.
  await topology.openHistory('source').click();
  await expect(topology.history()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/iface/${fixture.port.id}`));
  await expect(topology.historyGenerationBreak()).toBeVisible();
  await expect(topology.historySeries().first()).toBeVisible();
  expect(await topology.historySeries().evaluateAll((nodes) => [...new Set(nodes.map((n) => n.getAttribute('data-epoch')))]))
    .toEqual(expect.arrayContaining([fixture.port.epoch, 'e2e-previous-generation']));
  await expect(topology.historyGaps().first()).toContainText('Not measured');
  await topology.historyTableToggle().locator('summary').click();
  const values = await topology.historyValues().allTextContents();
  expect(values).toContain('0 bps');
  expect(values).toContain('Not measured');

  // Impact: explicit, cautious, never touches alerts.
  await topology.impactLoad().click();
  await expect(topology.impactNoAlerts()).toBeVisible();
  await expect(topology.impactMeasured()).toBeVisible();
  await expect(topology.impactPotential()).toBeVisible();
  await expect(topology.impactCause()).not.toBeEmpty();

  // Site operations: monitoring status and recent changes.
  await topology.operationsToggle().click();
  await expect(page).toHaveURL(/\/ops\/1/);
  await expect(topology.policy('gateway').first()).toBeVisible();
  await expect(topology.policies().getByTestId('topology-monitor-status')).toHaveText('Enable requested, not active');
  await topology.changesLoad().click();
  await expect(topology.changeRows().first()).toBeVisible();

  // Reload restores selection, open port history and the operations section from the hash.
  await page.reload();
  await expect(topology.history()).toBeVisible({ timeout: 60_000 });
  await expect(topology.operations()).toBeVisible();

  expect(mutations).toEqual([]);
  expect(operationsMutationRows(fixture)).toBe(rowsBefore);
});

test('monitoring: preview is passive, enable arms through the human route and reports the stored outcome', async ({ authedPage: page }) => {
  const mutations = recordMutations(page);
  const topology = new TopologyOperationsPage(page);
  await topology.openDiscoveryView(fixture.siteId, 'overview', fixture.orgId);
  await topology.operationsToggle().click();
  const policy = topology.policies().getByTestId('topology-policy-gateway');
  await policy.getByTestId('topology-monitor-preview').click();
  await expect(policy.getByTestId('topology-monitor-volume')).toContainText('per day');
  expect(mutations).toEqual([]);

  const arm = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/policies/${fixture.policyId}/arm`));
  await policy.getByTestId('topology-monitor-enable').click();
  const response = await arm;
  expect(mutations).toEqual([`POST /api/v1/topology/sites/${fixture.siteId}/policies/${fixture.policyId}/arm`]);
  // The fixture's only agent observes no routing context the gateway recipe can
  // use, so the server refuses the arm. The refusal is shown as an error with the
  // server's reason, never as a revision conflict, and nothing reads as active.
  expect(response.status()).toBe(409);
  expect(((await response.json()) as { code: string }).code).toBe('no_eligible_collector');
  expect(policyState(fixture).startsWith('false:')).toBe(true);
  await expect(policy.getByTestId('topology-monitor-status')).toHaveText('Enable requested, not active');
  await expect(policy.getByTestId('topology-monitor-conflict')).toHaveCount(0);
  await expect(policy.getByTestId('topology-monitor-disable')).toHaveCount(0);
});

test('port measurement: explicit port selection, volume preview, arm and revoke', async ({ authedPage: page }) => {
  const mutations = recordMutations(page);
  const topology = new TopologyOperationsPage(page);
  await topology.openDiscoveryView(fixture.siteId, 'physical', fixture.orgId);
  await topology.showList();
  await topology.node(fixture.nodes.sourceNode).click();
  await expect(topology.telemetry()).toBeVisible();
  await topology.telemetryPort(fixture.port.id).check();
  await topology.telemetryCollector().selectOption(fixture.collectorDeviceId);
  await topology.telemetryCredential().selectOption(fixture.credentialProfileId);
  await topology.telemetryPreview().click();
  await expect(topology.telemetryVolume()).toContainText('1440');
  expect(mutations).toEqual([]);

  const armed = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/telemetry-arms') && response.request().method() === 'POST');
  await topology.telemetryEnable().click();
  const response = await armed;
  expect(response.status()).toBe(201);
  const body = await response.json() as { id: string; interfaceCount: number; state: string };
  expect(body).toMatchObject({ interfaceCount: 1, state: 'armed' });
  await expect(topology.telemetryArm(body.id)).toContainText('Measuring');
  expect(telemetryArmStates(fixture)[0]).toBe('armed:');
  // Revoking only reduces authority: no step-up, the stored arm is revoked.
  await topology.telemetryArm(body.id).getByTestId('topology-telemetry-revoke').click();
  await expect(topology.telemetryArm(body.id)).toContainText('Off');
  expect(telemetryArmStates(fixture)[0]?.startsWith('revoked:')).toBe(true);
  expect(mutations).toEqual([`POST /api/v1/topology/sites/${fixture.siteId}/telemetry-arms`, `DELETE /api/v1/topology/sites/${fixture.siteId}/telemetry-arms/${body.id}`]);
});

test('trace request option is bounded and dispatches nothing until started', async ({ authedPage: page }) => {
  const mutations = recordMutations(page);
  const rowsBefore = operationsMutationRows(fixture);
  const topology = new TopologyOperationsPage(page);
  await topology.openDiscoveryView(fixture.siteId, 'overview', fixture.orgId);
  await topology.showList();
  await topology.node(fixture.nodes.agent).click();
  await topology.diagnose().click();
  await topology.recipeSelect().selectOption('trace_route');
  await expect(topology.traceMaxHops()).toHaveAttribute('max', '30');
  await expect(topology.traceProbes()).toHaveAttribute('max', '2');
  await topology.traceMaxHops().fill('8');
  await expect(topology.traceStart()).toBeVisible();
  expect(mutations).toEqual([]);
  expect(operationsMutationRows(fixture)).toBe(rowsBefore);
});
