import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  reads: [] as unknown[][],
  ensureDefaultProfile: vi.fn(async () => ({ id: 'profile' })),
}));
vi.mock('../services/billingProfileService', () => ({ ensureDefaultProfile: mocks.ensureDefaultProfile }));
vi.mock('../services/ticketConfigService', () => ({ seedSystemTicketStatuses: vi.fn() }));
vi.mock('../services/scriptVersions', () => ({ cutScriptVersion: vi.fn() }));
vi.mock('./index', () => {
  const db: any = {};
  db.select = vi.fn(() => {
    const chain: any = {};
    for (const name of ['from', 'where']) chain[name] = () => chain;
    chain.limit = async () => mocks.reads.shift() ?? [];
    return chain;
  });
  db.insert = vi.fn(() => ({ values: () => ({ returning: async () => [{ id: 'created', currencyCode: 'CAD' }] }) }));
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db, withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
import { db } from './index';
import { seedDefaultAdmin } from './seed';

beforeEach(() => { vi.clearAllMocks(); mocks.reads.length = 0; });
describe('bootstrap default billing cards', () => {
  it('ensures the partner and new organization currency in their existing transactions', async () => {
    // No user/partner/org, then the partner currency, existing site, no admin
    // role: stopping there isolates tenant creation from password generation.
    mocks.reads.push([], [], [], [{ currencyCode: 'CAD' }], [{ id: 'site' }], []);
    await seedDefaultAdmin();
    expect(mocks.ensureDefaultProfile).toHaveBeenNthCalledWith(1, 'created', 'CAD', db);
    expect(mocks.ensureDefaultProfile).toHaveBeenNthCalledWith(2, 'created', 'CAD', db);
  });
});
