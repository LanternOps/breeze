import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');

// W05c2 Task 18: one reproducible command verifies the integrated wave. It must
// carry the live isolation proofs, tear its stack down, and never use the
// `test -- --run` form that silently runs a whole suite in watch mode.
it('provides an executable verification manifest including real isolation proofs', () => {
  const path = resolve(root, 'scripts/verify-alerting-consolidation-w05c2.sh');
  expect(existsSync(path), 'missing W05c2 verification script').toBe(true);
  expect(statSync(path).mode & 0o111, 'verification script is not executable').not.toBe(0);
  const source = readFileSync(path, 'utf8');
  for (const required of [
    'tsc --noEmit',
    'vitest.integration.config.ts',
    'deviceMonitors.integration.test.ts',
    'fleetDesignApply.integration.test.ts',
    'monitorConversionsPartnerRls.integration.test.ts',
    'monitorConversionRoundtrip.integration.test.ts',
    'test:rls-coverage',
    'test-stack down',
  ]) {
    expect(source).toContain(required);
  }
  expect(source).not.toContain('test -- --run');
  expect(source).not.toContain('--passWithNoTests');
});
