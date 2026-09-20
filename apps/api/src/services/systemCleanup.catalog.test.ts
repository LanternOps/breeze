import { expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: {} }));
vi.mock('./commandQueue', () => ({ CommandTypes: {}, queueCommandForExecutionWithSystemPrecheck: vi.fn() }));
import { systemCleanupCatalogSchema } from './systemCleanup';

it('preserves per-handler rollback risk flags in the validated catalogue', () => {
  const riskFlags = ['removes_os_rollback'];
  const parsed = systemCleanupCatalogSchema.parse({
    catalogVersion: 1, volumesBefore: [], actions: [{
      id: 'win_cleanmgr', label: 'Disk Cleanup', description: 'Selected handlers', os: 'windows',
      available: true, estimateKnown: false, riskFlags: ['long_running'], affectsVolumes: [],
      subActions: [{ id: 'win_cleanmgr:previous_installations', label: 'Previous installations', estimateKnown: false, riskFlags }],
    }],
  });
  expect(parsed.actions[0]?.subActions?.[0]).toHaveProperty('riskFlags', riskFlags);
});
