/**
 * Avatar bytea storage — real-driver round-trip + RLS enforcement.
 *
 * Migration under test: 2026-06-11-j-avatar-bytea-columns.sql
 * Service under test:   services/avatarStorage.ts (DB-backed rewrite)
 *
 * The route tests in routes/users.test.ts mock the avatarStorage I/O behind an
 * in-memory Map, so nothing there proves that:
 *   1. postgres.js round-trips `bytea` byte-exactly as a Node Buffer (the
 *      schema's customType assumes Buffer in/out), and
 *   2. the UPDATE/SELECT on one's own `users` row actually passes the table's
 *      RLS policies as the unprivileged breeze_app role — the exact failure
 *      mode custom_field_definitions hit (#1257): policies looked fine in
 *      metadata, real writes 42501'd.
 * These tests run through the REAL driver inside withDbAccessContext.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { users } from '../../db/schema';
import { createPartner, createUser } from './db-utils';
import { deleteAvatar, readAvatarBuffer, statAvatar, writeAvatar } from '../../services/avatarStorage';

// Valid PNG magic + every byte value 0..255 — catches any encoding/escaping
// mangling in the bytea path (e.g. the text::bytea class of bug from #994).
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]);

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x42),
]);

/** Request-shaped context for an MSP-staff user acting as themselves. */
function selfContext(partnerId: string, userId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId,
  };
}

describe('avatar bytea round-trip (real driver, RLS enforced)', () => {
  it('write → stat → read → delete round-trips byte-exactly in the user\'s own context', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const ctx = selfContext(partner.id, user.id);

    await withDbAccessContext(ctx, async () => {
      const written = await writeAvatar(user.id, 'image/png', PNG_BYTES);
      expect(written).not.toBeNull();
      expect(written!.avatarUrl).toBe(`/api/v1/users/${user.id}/avatar`);
      expect(written!.size).toBe(PNG_BYTES.length);

      // statAvatar computes size via octet_length — must match without
      // transferring the blob.
      const stat = await statAvatar(user.id);
      expect(stat).not.toBeNull();
      expect(stat!.mime).toBe('image/png');
      expect(stat!.size).toBe(PNG_BYTES.length);
      expect(stat!.mtimeMs).toBeGreaterThan(0);

      const opened = await readAvatarBuffer(user.id);
      expect(opened).not.toBeNull();
      expect(Buffer.isBuffer(opened!.buffer)).toBe(true);
      expect(opened!.buffer.equals(PNG_BYTES)).toBe(true);
      expect(opened!.mime).toBe('image/png');

      // avatar_url landed on the row in the same UPDATE.
      const [row] = await db.select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, user.id)).limit(1);
      expect(row?.avatarUrl).toBe(`/api/v1/users/${user.id}/avatar`);

      expect(await deleteAvatar(user.id)).toBe(true);
      expect(await statAvatar(user.id)).toBeNull();
      const [after] = await db.select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, user.id)).limit(1);
      expect(after?.avatarUrl).toBeNull();
    });
  });

  it('overwriting replaces bytes and mime in place', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const ctx = selfContext(partner.id, user.id);

    await withDbAccessContext(ctx, async () => {
      await writeAvatar(user.id, 'image/png', PNG_BYTES);
      await writeAvatar(user.id, 'image/jpeg', JPEG_BYTES);

      const opened = await readAvatarBuffer(user.id);
      expect(opened!.mime).toBe('image/jpeg');
      expect(opened!.buffer.equals(JPEG_BYTES)).toBe(true);
    });
  });

  it('RLS fails closed: a foreign-partner context sees no avatar and cannot write one', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const userA = await createUser({ partnerId: partnerA.id });
    const userB = await createUser({ partnerId: partnerB.id });

    await withDbAccessContext(selfContext(partnerA.id, userA.id), async () => {
      await writeAvatar(userA.id, 'image/png', PNG_BYTES);
    });

    // userB (different partner) can neither see userA's avatar nor write over
    // it — the UPDATE matches no visible row and writeAvatar reports null.
    await withDbAccessContext(selfContext(partnerB.id, userB.id), async () => {
      expect(await statAvatar(userA.id)).toBeNull();
      expect(await readAvatarBuffer(userA.id)).toBeNull();
      expect(await writeAvatar(userA.id, 'image/jpeg', JPEG_BYTES)).toBeNull();
    });

    // userA's avatar is untouched.
    await withDbAccessContext(selfContext(partnerA.id, userA.id), async () => {
      const opened = await readAvatarBuffer(userA.id);
      expect(opened!.mime).toBe('image/png');
      expect(opened!.buffer.equals(PNG_BYTES)).toBe(true);
    });
  });
});
