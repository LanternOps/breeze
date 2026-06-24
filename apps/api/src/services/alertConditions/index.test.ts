import { describe, it, expect, vi } from 'vitest';

// utils.ts (transitively imported by the handlers) pulls in the db module at
// import time; stub it so importing the registry doesn't open a connection.
vi.mock('../../db', () => ({ db: {} }));

import './index';
import { conditionRegistry } from './registry';
import { offlineHandler } from './handlers/offline';

describe('condition registry wiring (issue #1857)', () => {
  it('resolves the legacy "status" condition type to the offline handler', () => {
    expect(conditionRegistry.get('status')).toBe(offlineHandler);
  });

  it('resolves the canonical "offline" condition type to the offline handler', () => {
    expect(conditionRegistry.get('offline')).toBe(offlineHandler);
  });

  it('returns an "Unknown condition type" result for a genuinely unregistered type', async () => {
    const result = await conditionRegistry.evaluate(
      { type: 'definitely-not-a-real-type' } as never,
      'device-1'
    );
    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/Unknown condition type/);
  });
});
