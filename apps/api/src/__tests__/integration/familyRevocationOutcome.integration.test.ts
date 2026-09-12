import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { refreshTokenFamilies } from '../../db/schema';
import * as redisService from '../../services/redis';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { revokeFamily } from '../../services/tokenRevocation';
import { createPartner, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

async function readFamily(familyId: string) {
  const [row] = await getTestDb().select().from(refreshTokenFamilies)
    .where(eq(refreshTokenFamilies.familyId, familyId));
  return row;
}

async function seedFamily() {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id });
  return mintRefreshTokenFamily(user.id);
}

describe('family revocation outcomes with real request-role transactions', () => {
  beforeEach(() => { vi.spyOn(redisService, 'getRedis').mockReturnValue(getTestRedis()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('acknowledges the committed row and Redis sentinel; repeats preserve the first revocation', async () => {
    const [role] = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS name, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `));
    expect(role).toMatchObject({ name: 'breeze_app', rolsuper: false, rolbypassrls: false });
    const familyId = await seedFamily();
    expect(await revokeFamily(familyId, 'x'.repeat(100))).toEqual({ redis: 'confirmed', database: 'confirmed' });
    const first = await readFamily(familyId);
    expect(first?.revokedAt).toBeInstanceOf(Date);
    expect(first?.revokedReason).toBe('x'.repeat(64));
    expect(await getTestRedis().get(`refresh-fam-revoked:${familyId}`)).toBe('1');

    expect(await revokeFamily(familyId, 'later-reason')).toEqual({ redis: 'confirmed', database: 'confirmed' });
    expect(await readFamily(familyId)).toEqual(first);
  });

  it('reports an unmatched row as unconfirmed even if Redis accepts the sentinel', async () => {
    const familyId = randomUUID();
    expect(await revokeFamily(familyId, 'reuse-detected')).toEqual({ redis: 'confirmed', database: 'not_found' });
    expect(await readFamily(familyId)).toBeUndefined();
  });

  it('independently commits before reporting confirmation inside an ambient context that later rolls back', async () => {
    const familyId = await seedFamily();
    await expect(withDbAccessContext({
      scope: 'organization', orgId: null, accessibleOrgIds: [], userId: null,
    }, async () => {
      expect(await revokeFamily(familyId, 'reuse-detected')).toEqual({ redis: 'confirmed', database: 'confirmed' });
      throw new Error('ambient rollback');
    })).rejects.toThrow('ambient rollback');
    expect((await readFamily(familyId))?.revokedAt).toBeInstanceOf(Date);
  });

  it('still commits the durable revocation when Redis is unavailable', async () => {
    vi.mocked(redisService.getRedis).mockReturnValue(null);
    const familyId = await seedFamily();
    expect(await revokeFamily(familyId, 'reuse-detected')).toEqual({ redis: 'unavailable', database: 'confirmed' });
    expect((await readFamily(familyId))?.revokedAt).toBeInstanceOf(Date);
  });
});
