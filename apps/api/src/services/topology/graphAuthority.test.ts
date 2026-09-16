import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ redis: vi.fn(), mget: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: mocks.redis }));
vi.mock('../../db', () => ({ db: {}, getCurrentDbAccessContext: vi.fn(), runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
import { getPermissionAuthorityVersion } from '../permissions';
beforeEach(() => { vi.clearAllMocks(); mocks.redis.mockReturnValue({ mget: mocks.mget }); });
describe('topology permission authority version adapter', () => {
  it('uses both global and per-user invalidation generations without precision loss', async () => {
    mocks.mget.mockResolvedValue(['9007199254740993', '7']);
    expect(await getPermissionAuthorityVersion('actor')).toBe('["9007199254740993","7"]');
    expect(mocks.mget).toHaveBeenCalledWith('permission-cache:version', 'permission-cache:user-version:actor');
  });
  it('uses initial zero generations only after a successful Redis response', async () => {
    mocks.mget.mockResolvedValue([null, null]); expect(await getPermissionAuthorityVersion('actor')).toBe('["0","0"]');
  });
  it('fails closed when Redis is absent or rejects the version lookup', async () => {
    mocks.redis.mockReturnValueOnce(null); expect(await getPermissionAuthorityVersion('actor')).toBeNull();
    mocks.mget.mockRejectedValue(new Error('Redis unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getPermissionAuthorityVersion('actor')).toBeNull(); expect(error).toHaveBeenCalledOnce(); error.mockRestore();
  });
});
