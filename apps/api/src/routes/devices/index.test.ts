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

  it('mounts the billing sub-resource after core parameter routes (#3205 W06)', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { billingRoutes } from './billing'");
    const billingMount = source.indexOf("deviceRoutes.route('/', billingRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(billingMount).toBeGreaterThan(-1);
    expect(billingMount).toBeGreaterThan(coreMount);
  });
});
