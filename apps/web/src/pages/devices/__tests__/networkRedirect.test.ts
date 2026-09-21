import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// #6501: `/devices/network` (bare path) is captured by this catch-all route
// with id="network" and, before this fix, went on to fetch the device-detail
// endpoint — which collides with the network-asset list API at the same
// path and rendered a phantom device page. Assert the redirect stays wired
// up so that regresses loudly (this file, not just DeviceDetailPage's
// payload-shape guard) rather than silently.
it('redirects /devices/network to /devices#deviceClass=network', () => {
  const src = readFileSync(resolve(__dirname, '../[id].astro'), 'utf-8');
  expect(src).toMatch(/Astro\.redirect\(['"]\/devices#deviceClass=network['"]\)/);
});
