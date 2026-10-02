import { beforeEach, describe, expect, it, vi } from 'vitest';

// Review finding (PR #7643): two admins promoting different models at once
// race on ai_platform_models_one_default_uq. The loser must get a 409 it can
// act on, not a raw 23505 surfacing as a 500.
const { withSystemDbAccessContextMock } = vi.hoisted(() => ({ withSystemDbAccessContextMock: vi.fn() }));
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  runAfterDbContextExit: vi.fn(),
}));

import { PlatformModelError, updatePlatformModelAdmin } from './platformModels';

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, constraint_name: constraint });
}

describe('updatePlatformModelAdmin concurrent default swap', () => {
  beforeEach(() => {
    withSystemDbAccessContextMock.mockReset();
  });

  it('maps a one-default unique violation to a 409 PlatformModelError', async () => {
    withSystemDbAccessContextMock.mockRejectedValue(pgError('23505', 'ai_platform_models_one_default_uq'));
    const error = await updatePlatformModelAdmin('00000000-0000-4000-8000-000000000001', { isPlatformDefault: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformModelError);
    expect(error).toMatchObject({ status: 409 });
  });

  it('rethrows any other database error unchanged', async () => {
    const other = pgError('23505', 'ai_platform_models_model_id_uq');
    withSystemDbAccessContextMock.mockRejectedValue(other);
    await expect(updatePlatformModelAdmin('00000000-0000-4000-8000-000000000001', { minPlan: null })).rejects.toBe(other);
  });
});
