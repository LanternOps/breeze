import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMappableOrgs = vi.hoisted(() => vi.fn());
vi.mock('./mappableOrgs', () => ({ loadMappableOrgs }));
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('../jobs/backupProviderSync', () => ({ enqueueBackupProviderSync: vi.fn() }));

import { autoMapEdrTenants } from './edrProviders/mapping';
import { autoMapCustomers } from './backupProviders/mapping';

const PARTNER = '00000000-0000-4000-8000-0000000000a1';

/** A tx whose only select returns one unmapped row; the orgs read must go through loadMappableOrgs. */
function txWithUnmappedRow(row: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve([row]));
  return { select: vi.fn(() => chain), execute: vi.fn(async () => []) };
}

describe('mapping callers use the shared loadMappableOrgs', () => {
  beforeEach(() => { loadMappableOrgs.mockReset().mockResolvedValue([]); });

  it('edrProviders/mapping autoMapEdrTenants', async () => {
    const tx = txWithUnmappedRow({ id: 't1', vendorName: 'X', vendorExternalCode: null });
    await autoMapEdrTenants(tx as never, { id: 'c1', partnerId: PARTNER, provider: 'bitdefender' } as never);
    expect(loadMappableOrgs).toHaveBeenCalledWith(tx, PARTNER);
    expect(tx.select).toHaveBeenCalledTimes(1); // no inline orgs query
  });

  it('backupProviders/mapping autoMapCustomers', async () => {
    const tx = txWithUnmappedRow({ id: 'k1', vendorCustomerName: 'X', vendorExternalCode: null });
    await autoMapCustomers(tx as never, 'c1', PARTNER);
    expect(loadMappableOrgs).toHaveBeenCalledWith(tx, PARTNER);
    expect(tx.select).toHaveBeenCalledTimes(1);
  });
});
