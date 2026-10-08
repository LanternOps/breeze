/**
 * Unit coverage for the storage-key hand-off added in #8117. The children-first
 * delete order itself is proven against real Postgres in the
 * topologyAiSessionLifecycle / siteTopologySessions integration suites.
 */
import { describe, expect, it, vi } from 'vitest';

import { aiScreenshots } from '../../db/schema';
import { deleteSiteTopologyAiSessions } from './siteTopologySessions';

function makeExecutor(screenshotRows: Array<{ id: string; storageKey: string }>) {
  const returningArgs = new Map<unknown, unknown>();
  const executor = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => [{ id: 'session-1' }]) })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async (shape: unknown) => {
          returningArgs.set(table, shape);
          return table === aiScreenshots ? screenshotRows : [{ id: 'x' }];
        }),
      })),
    })),
  };
  return { executor, returningArgs };
}

describe('deleteSiteTopologyAiSessions', () => {
  it('returns the deleted screenshots\' storage keys so the caller can remove the files after commit', async () => {
    const { executor, returningArgs } = makeExecutor([
      { id: 's1', storageKey: 'screenshots/o/d/a.jpg' },
      { id: 's2', storageKey: 'screenshots/o/d/b.jpg' },
    ]);

    const result = await deleteSiteTopologyAiSessions(executor as never, { orgId: 'org-1', siteId: 'site-1' });

    expect(returningArgs.get(aiScreenshots)).toHaveProperty('storageKey');
    expect(result.screenshots).toBe(2);
    expect(result.screenshotStorageKeys).toEqual(['screenshots/o/d/a.jpg', 'screenshots/o/d/b.jpg']);
  });

  it('returns no keys when the site has no topology investigations', async () => {
    const executor = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
      delete: vi.fn(),
    };

    const result = await deleteSiteTopologyAiSessions(executor as never, { orgId: 'org-1', siteId: 'site-1' });

    expect(result.screenshotStorageKeys).toEqual([]);
    expect(executor.delete).not.toHaveBeenCalled();
  });
});
