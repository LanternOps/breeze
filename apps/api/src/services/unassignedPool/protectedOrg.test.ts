import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn();
vi.mock('../../db', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })) },
}));

import { isHoldingOrg } from './protectedOrg';

describe('isHoldingOrg', () => {
  beforeEach(() => limit.mockReset());

  it('is true only for an unassigned_pool row', async () => {
    limit.mockResolvedValueOnce([{ type: 'unassigned_pool' }]);
    await expect(isHoldingOrg('o1')).resolves.toBe(true);
    limit.mockResolvedValueOnce([{ type: 'quick_support' }]);
    await expect(isHoldingOrg('o2')).resolves.toBe(false);
    limit.mockResolvedValueOnce([]);
    await expect(isHoldingOrg('o3')).resolves.toBe(false);
  });
});
