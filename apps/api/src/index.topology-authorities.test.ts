import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// M2 D1: physical producer authorities are default-deny, so the API boot must
// install them explicitly. index.ts's boot sequence runs as an import side
// effect and is not otherwise unit-testable, so (like index.bootBinarySync.test)
// this asserts on the source: bootstrap() calls the registration, alongside the
// other synchronous in-process registries, before any listener is started.
describe('API boot registers physical topology authorities (M2 D1)', () => {
  it('bootstrap() calls registerTopologyPhysicalAuthorities before serving', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const bootstrap = source.indexOf('async function bootstrap(): Promise<void> {');
    const call = source.indexOf('registerTopologyPhysicalAuthorities();');
    const serve = source.indexOf('serve(', bootstrap);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(bootstrap);
    expect(serve === -1 || call < serve).toBe(true);
    expect(source).toContain("import { registerTopologyPhysicalAuthorities } from './services/topology/physicalAuthorities';");
  });
});
