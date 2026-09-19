import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #5287 W02 shipped `/monitor-definitions` without `authMiddleware`, so every
 * request reached `requireScope` with no auth context and 401'd
 * ("Not authenticated" on /monitoring/monitors/new, "Failed to load monitors"
 * on the config-policy Monitors tab). The route unit tests mock the whole
 * auth module, so they cannot see it — this source-level contract can.
 */
describe('monitorDefinitionRoutes auth gate', () => {
  const source = readFileSync(join(__dirname, 'monitorDefinitions.ts'), 'utf8');

  it('applies authMiddleware to every route before the first handler is registered', () => {
    const gate = source.indexOf("monitorDefinitionRoutes.use('*', authMiddleware)");
    const firstRoute = source.search(/monitorDefinitionRoutes\.(get|post|patch|put|delete)\(/);
    expect(gate).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstRoute);
  });
});
