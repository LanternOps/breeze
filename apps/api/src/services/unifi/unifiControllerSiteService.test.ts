import { describe, it, expect, vi } from 'vitest';
import { upsertControllerSites } from './unifiControllerSiteService';

function mockDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as any, values };
}

describe('upsertControllerSites', () => {
  it('upserts one row per reported site with the collector org', async () => {
    const { db, values } = mockDb();
    await upsertControllerSites(db, 'col-1', 'org-1', [{ id: 's1', name: 'HQ' }, { id: 's2' }]);
    expect(values).toHaveBeenCalledTimes(2);
    expect(values.mock.calls[0]![0]).toMatchObject({ collectorId: 'col-1', orgId: 'org-1', localSiteId: 's1', name: 'HQ' });
    expect(values.mock.calls[1]![0]).toMatchObject({ collectorId: 'col-1', orgId: 'org-1', localSiteId: 's2', name: null });
  });

  it('no-ops on an empty list', async () => {
    const { db, values } = mockDb();
    await upsertControllerSites(db, 'col-1', 'org-1', []);
    expect(values).not.toHaveBeenCalled();
  });
});
