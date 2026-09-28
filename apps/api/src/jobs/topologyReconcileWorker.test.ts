import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, assertInTransaction: vi.fn(), runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
vi.mock('../services/topology/reconcile', () => ({ reconcileTopologySite: vi.fn() }));
vi.mock('../services/topology/flags', () => ({ loadTopologyFlags: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { initializeTopologyReconcileWorker, shutdownTopologyReconcileWorker } from './topologyReconcileWorker';
import { isTopologyProducerAuthorityRegistered, resetTopologyProducerAuthoritiesForTest } from '../services/topology/collectionAuthority';

describe('topology reconcile worker boot (M2 D1)', () => {
  afterEach(async () => { await shutdownTopologyReconcileWorker(); resetTopologyProducerAuthoritiesForTest(); });

  it('installs both physical producer authorities when it initializes', () => {
    expect(isTopologyProducerAuthorityRegistered('discovery')).toBe(false);
    expect(isTopologyProducerAuthorityRegistered('unifi')).toBe(false);
    initializeTopologyReconcileWorker();
    expect(isTopologyProducerAuthorityRegistered('discovery')).toBe(true);
    expect(isTopologyProducerAuthorityRegistered('unifi')).toBe(true);
  });
});
