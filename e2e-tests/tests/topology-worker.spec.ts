import { expect, test } from '@playwright/test';
import { TopologyPage } from '../pages/TopologyPage';
import { installTopologyWorkerFixture } from '../helpers/topologyWorkerFixture';

test('production module worker executes ELK under CSP and preserves pins without implicit writes', async ({ page }) => {
  const fixture = await installTopologyWorkerFixture(page), topology = new TopologyPage(page);
  const workers: string[] = [], errors: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await topology.openNetworkDevice(fixture.assetId);
  await expect(topology.internetHealth()).toHaveText('Not measured');
  await expect.poll(() => page.evaluate(() => (window as any).topologyWorkerCapture.results.length)).toBeGreaterThan(0);
  const capture = await page.evaluate(() => (window as any).topologyWorkerCapture);
  const result = capture.results.at(-1), request = capture.requests.at(-1);
  expect(result.warning).toBeUndefined();
  expect(result.positions.find((position: any) => position.nodeId === fixture.nodeId)).toMatchObject({ x: 320, y: 180, pinned: true });
  for (const a of result.positions) for (const b of result.positions) {
    if (a.nodeId >= b.nodeId) continue;
    const ab = request.nodes.find((box: any) => box.id === a.nodeId), bb = request.nodes.find((box: any) => box.id === b.nodeId);
    expect(Math.abs(a.x - b.x) >= (ab.width + bb.width) / 2 || Math.abs(a.y - b.y) >= (ab.height + bb.height) / 2).toBe(true);
  }
  expect(workers.some((url) => /\/_astro\/layout\.worker-/.test(url))).toBe(true);
  expect(workers.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  // Zod's optional capability probe is caught under the existing strict CSP.
  // Report it separately; forbid blocked inline scripts or worker resources.
  test.info().annotations.push({ type: 'csp-eval-probes', description: JSON.stringify(capture.violations.filter((item: string) => item.includes(': eval '))) });
  expect(capture.violations.filter((item: string) => !item.includes(': eval '))).toEqual([]); expect(errors).toEqual([]); expect(fixture.mutations).toEqual([]);
  await topology.listToggle().click(); await topology.node(fixture.nodeId).click();
  await expect(topology.inspector()).toBeVisible();
  await topology.arrange().click(); expect(fixture.mutations).toEqual([]);
});
