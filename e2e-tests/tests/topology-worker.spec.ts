import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TopologyPage } from '../pages/TopologyPage';
import { installTopologyWorkerFixture } from '../helpers/topologyWorkerFixture';
import { seedBaselineTopology } from '../helpers/topologyFixture';

/**
 * Production layout-worker gate. Served by `playwright.topology-worker.config.ts`
 * from the BUILT Astro server (`apps/web/dist`), so the module worker, its
 * emitted same-origin asset URL and the shipped CSP are the real ones. A mocked
 * Worker in a unit test does not satisfy this gate; the two cases below that
 * deliberately install a stub Worker say so at the point of use.
 */

const capture = (page: Page) => page.evaluate(() => (window as { topologyWorkerCapture?: unknown }).topologyWorkerCapture as {
  requests: { requestId: string; graphRevision: string; layoutRevision: string; measurementRevision: string; algorithmVersion: string; nodes: { id: string; width: number; height: number }[] }[];
  results: { warning?: string; positions: { nodeId: string; x: number; y: number; pinned: boolean }[] }[];
  violations: string[];
});

test('production module worker executes ELK under CSP and preserves pins without implicit writes', async ({ page }) => {
  const fixture = await installTopologyWorkerFixture(page), topology = new TopologyPage(page);
  const workers: string[] = [], errors: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await topology.openNetworkDevice(fixture.assetId);
  await expect(topology.internetHealth()).toHaveText('Not measured');
  await expect.poll(() => page.evaluate(() => (window as any).topologyWorkerCapture.results.length)).toBeGreaterThan(0);
  const captured = await capture(page);
  const result = captured.results.at(-1)!, request = captured.requests.at(-1)!;
  expect(result.warning).toBeUndefined();
  expect(result.positions.find((position) => position.nodeId === fixture.nodeId)).toMatchObject({ x: 320, y: 180, pinned: true });
  for (const a of result.positions) for (const b of result.positions) {
    if (a.nodeId >= b.nodeId) continue;
    const ab = request.nodes.find((box) => box.id === a.nodeId)!, bb = request.nodes.find((box) => box.id === b.nodeId)!;
    expect(Math.abs(a.x - b.x) >= (ab.width + bb.width) / 2 || Math.abs(a.y - b.y) >= (ab.height + bb.height) / 2).toBe(true);
  }
  expect(workers.some((url) => /\/_astro\/layout\.worker-/.test(url))).toBe(true);
  expect(workers.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(captured.violations).toEqual([]); expect(errors).toEqual([]); expect(fixture.mutations).toEqual([]);
  await topology.listToggle().click(); await topology.node(fixture.nodeId).click();
  await expect(topology.inspector()).toBeVisible();
  await topology.arrange().click(); expect(fixture.mutations).toEqual([]);
});

test('the real worker moves deterministic input and loads no CDN, model or cross-origin asset', async ({ page }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  const workers: string[] = [], violations: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|worker/i.test(message.text())) violations.push(message.text()); });

  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await expect.poll(() => page.evaluate(() => (window as any).topologyWorkerCapture.results.length)).toBeGreaterThan(0);
  const captured = await capture(page);
  const result = captured.results.at(-1)!;

  // The ELK engine actually ran: the unpinned nodes were placed, and the saved
  // pin came back untouched. A no-op adapter would return the input unchanged.
  expect(result.warning).toBeUndefined();
  expect(result.positions.length).toBeGreaterThan(1);
  expect(result.positions.find((position) => position.nodeId === f.ids.gatewayNodeId)).toMatchObject({ x: 320, y: 180, pinned: true });
  expect(result.positions.filter((position) => !position.pinned).every((position) => Number.isFinite(position.x) && Number.isFinite(position.y))).toBe(true);
  expect(new Set(result.positions.map((position) => `${position.x}/${position.y}`)).size).toBe(result.positions.length);

  // Both the layout worker and ELK's own engine worker are same-origin assets.
  const base = new URL(page.url()).origin;
  expect(workers.some((url) => /\/_astro\/layout\.worker-/.test(url))).toBe(true);
  expect(workers.some((url) => /\/_astro\/elkEngine\.worker-/.test(url))).toBe(true);
  expect(workers.every((url) => new URL(url).origin === base)).toBe(true);
  expect(violations).toEqual([]);
  expect(captured.violations).toEqual([]);
  expect(f.externalRequests()).toEqual([]);

  // Reading the map issues no topology write at all, authorized or otherwise.
  expect(f.apiRequests().filter((entry) => entry.method !== 'GET' && entry.path.startsWith('/topology'))).toEqual([]);
  // The only non-topology writes are the app shell's own session plumbing.
  const shellWrites = new Set(f.apiRequests().filter((entry) => entry.method !== 'GET').map((entry) => entry.path));
  expect([...shellWrites].sort()).toEqual(['/auth/refresh', '/events/ws-ticket']);
  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
});

test('the island is server-rendered and then hydrates', async ({ page, request }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  const html = await (await request.get(`/devices/network/${f.ids.networkDeviceId}`)).text();
  // Server-rendered island markup, before any client JavaScript runs.
  expect(html).toContain('astro-island');
  expect(html).toContain('NetworkDeviceDetailPage');

  await topology.openNetworkDevice(f.ids.networkDeviceId);
  // Hydration proof: a client-only interaction changes the DOM.
  await topology.listToggle().click();
  await expect(topology.list()).toBeVisible();
});

test('switching site terminates the in-flight worker and starts a fenced new one', async ({ page }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  const closed: string[] = [], started: string[] = [];
  page.on('worker', (worker) => { started.push(worker.url()); worker.on('close', () => closed.push(worker.url())); });

  await topology.openDiscovery(f.ids.siteId);
  await expect.poll(() => page.evaluate(() => (window as any).topologyWorkerCapture.results.length)).toBeGreaterThan(0);
  const beforeSwitch = started.length;

  await topology.siteSelect().selectOption(f.ids.otherSiteId);
  await topology.explorer().waitFor();
  await expect.poll(() => started.length).toBeGreaterThan(beforeSwitch);
  // The controller terminates rather than orphaning the superseded worker.
  await expect.poll(() => closed.length).toBeGreaterThan(0);

  const captured = await capture(page);
  const last = captured.requests.at(-1)!, first = captured.requests[0]!;
  expect(last.requestId).not.toBe(first.requestId);
  expect(await f.effects()).toMatchObject({ commands: 0, layoutWrites: 0 });
});

test('a worker that never answers falls back to a deterministic grid that keeps pins', async ({ page }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  // Deliberate stub: the production bundle cannot be made to hang on demand, so
  // the 3s timeout path is driven by a Worker that accepts and never replies.
  await page.addInitScript(() => {
    class SilentWorker extends EventTarget {
      onmessage: unknown = null; onerror: unknown = null;
      postMessage() {} terminate() {}
    }
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: SilentWorker });
  });

  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await expect(topology.layoutWarning()).toBeVisible({ timeout: 20_000 });
  await expect(topology.layoutWarning()).toContainText('Automatic arrangement reached its limit');

  // The fallback still refuses to write anything to the server.
  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
});

test('a layout result whose fence no longer matches is discarded', async ({ page }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  // Deliberate stub: a stale fence cannot be forged through the real worker, so
  // this one answers twice — once with an obsolete graph revision carrying an
  // absurd placement, then once correctly.
  await page.addInitScript(() => {
    class ReplayWorker extends EventTarget {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      postMessage(request: Record<string, unknown>) {
        const positions = (request.positions as { nodeId: string; x: number; y: number; pinned: boolean }[]);
        const boxes = request.nodes as { id: string }[];
        const stale = { ...request, graphRevision: 'obsolete', positions: boxes.map((box, index) => ({ nodeId: box.id, x: 9999 + index, y: 9999, pinned: false })) };
        const fresh = { ...request, positions: boxes.map((box, index) => ({ nodeId: box.id, x: index * 400, y: 0, pinned: positions.some((position) => position.nodeId === box.id && position.pinned) })) };
        queueMicrotask(() => { this.onmessage?.({ data: stale }); this.onmessage?.({ data: fresh }); });
      }
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: ReplayWorker });
  });

  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await expect(topology.unsavedLayout()).toBeVisible();
  await topology.saveLayout().click();

  expect((await f.effects()).layoutWrites).toBe(1);
  const [batch] = f.layoutPatches();
  expect(batch.length).toBeGreaterThan(1);
  // The obsolete-fence placement (9999,…) never reached the draft, so it can
  // never reach the shared layout either.
  expect(batch.every((position) => position.x < 9999 && position.y < 9999)).toBe(true);
  // Only the fresh reply's deterministic 400px lattice survived.
  expect(batch.every((position) => position.x % 400 === 0 && position.y === 0)).toBe(true);
});

test('list and canvas are keyboard-equivalent and Escape returns focus', async ({ page }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.ids.networkDeviceId);

  await topology.listToggle().focus();
  await page.keyboard.press('Enter');
  await expect(topology.list()).toBeVisible();

  await topology.node(f.ids.gatewayNodeId).focus();
  await page.keyboard.press('Enter');
  await expect(topology.inspector()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(topology.inspector()).toHaveCount(0);
  await expect(topology.listToggle()).toBeFocused();

  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
});

test('a conflicting shared-layout save is surfaced and the local preview survives', async ({ page }) => {
  const f = await seedBaselineTopology(page), topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.ids.networkDeviceId);
  await expect(topology.unsavedLayout()).toBeVisible();

  f.failNextLayoutSave();
  await topology.saveLayout().click();

  await expect(topology.layoutConflict()).toBeVisible();
  await expect(topology.unsavedLayout()).toBeVisible();
  // A rejected save is not a write.
  expect((await f.effects()).layoutWrites).toBe(0);
  expect(f.apiRequests().filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
});
