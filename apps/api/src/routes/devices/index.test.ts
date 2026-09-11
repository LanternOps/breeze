import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('device router mount order', () => {
  it('mounts the agent rollback sub-resource before core parameter routes', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const rollbackMount = source.indexOf("deviceRoutes.route('/', agentRollbackRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(rollbackMount).toBeGreaterThan(-1);
    expect(coreMount).toBeGreaterThan(rollbackMount);
  });

  it('mounts the Remove-dialog config route before core parameter routes (#3987)', () => {
    // `/removal-config` is a STATIC path under /devices. Mounted after
    // coreRoutes, core's `GET /:id` matcher would claim it and the Remove
    // dialog would fetch a 404 (or a 400 uuid error) instead of the window.
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { removalConfigRoutes } from './removalConfig'");
    const removalMount = source.indexOf("deviceRoutes.route('/', removalConfigRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(removalMount).toBeGreaterThan(-1);
    expect(coreMount).toBeGreaterThan(removalMount);
  });

  it('mounts the billing sub-resource after core parameter routes (#3205 W06)', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { billingRoutes } from './billing'");
    const billingMount = source.indexOf("deviceRoutes.route('/', billingRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(billingMount).toBeGreaterThan(-1);
    expect(billingMount).toBeGreaterThan(coreMount);
  });
});
