/**
 * Per-user Pushover keys against real Postgres. In system scope (the notify
 * worker) the loader returns exactly the requested user's key. In a user's own
 * scope (the profile routes run there), a same-partner peer can neither read
 * nor overwrite another user's sealed key: the table's user-isolation RLS.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ticketPushPreferences } from '../../db/schema';
import { loadUserPushoverKey, sealPushoverUserKey } from '../../services/ticketPushover';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
let seq = 0;

describe('per-user Pushover key storage', () => {
  runDb('stores sealed, and loads only the requested user\'s own key', async () => {
    await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const a = await createUser({ partnerId: partner.id, email: `po-a-${Date.now()}-${seq++}@example.com` });
      const b = await createUser({ partnerId: partner.id, email: `po-b-${Date.now()}-${seq++}@example.com` });
      const c = await createUser({ partnerId: partner.id, email: `po-c-${Date.now()}-${seq++}@example.com` });
      const KEY_A = 'a'.repeat(30);
      const KEY_B = 'b'.repeat(30);
      await db.insert(ticketPushPreferences).values([
        { userId: a.id, pushoverUserKeyEncrypted: sealPushoverUserKey(a.id, KEY_A) },
        { userId: b.id, pushoverUserKeyEncrypted: sealPushoverUserKey(b.id, KEY_B) },
      ]);

      const [rawA] = await db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, a.id));
      expect(rawA!.pushoverUserKeyEncrypted).not.toBe(KEY_A);

      expect(await loadUserPushoverKey(a.id)).toBe(KEY_A);
      expect(await loadUserPushoverKey(b.id)).toBe(KEY_B);
      expect(await loadUserPushoverKey(c.id)).toBeNull();
    });
  });

  runDb('a same-partner peer cannot read or overwrite another user\'s key (user scope)', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const a = await createUser({ partnerId: partner.id, orgId: org.id });
      const b = await createUser({ partnerId: partner.id, orgId: org.id });
      await db.insert(ticketPushPreferences).values({ userId: a.id, pushoverUserKeyEncrypted: sealPushoverUserKey(a.id, 'a'.repeat(30)) });
      return { partner, org, a, b };
    });
    const ctxB: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [fx.org.id], accessiblePartnerIds: [fx.partner.id], userId: fx.b.id };

    const read = await withDbAccessContext(ctxB, () =>
      db.select({ k: ticketPushPreferences.pushoverUserKeyEncrypted }).from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.a.id)));
    expect(read).toHaveLength(0);
    const updated = await withDbAccessContext(ctxB, () =>
      db.update(ticketPushPreferences).set({ pushoverUserKeyEncrypted: null })
        .where(eq(ticketPushPreferences.userId, fx.a.id)).returning({ userId: ticketPushPreferences.userId }));
    expect(updated).toHaveLength(0);

    const still = await withSystemDbAccessContext(() => loadUserPushoverKey(fx.a.id));
    expect(still).toBe('a'.repeat(30));
  });
});
