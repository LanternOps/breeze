/**
 * Partner suspend/unsuspend user-scoping (#917 L-5)
 *
 * Before the fix, unsuspend did `UPDATE users SET status='active' WHERE
 * partner_id=? AND status='disabled'` and re-enabled EVERY disabled user under
 * the partner — including users disabled for compromise / off-boarding. These
 * tests run the real `disablePartnerUsersForSuspension` /
 * `reEnableSuspensionDisabledUsers` queries against Postgres to prove unsuspend
 * only restores users the suspension itself disabled (those carrying the
 * `disabled_reason='partner_suspended'` marker).
 *
 * Prerequisites: docker compose -f docker-compose.test.yml up -d
 * Run: pnpm test:integration -- src/__tests__/integration/partnerUnsuspendScope.integration.test.ts
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema';
import {
  disablePartnerUsersForSuspension,
  reEnableSuspensionDisabledUsers,
} from '../../routes/admin/abuse';
import { createPartner, createUser } from './db-utils';

function readUser(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: users.status, disabledReason: users.disabledReason })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row;
  });
}

describe('partner suspend/unsuspend user scoping (#917 L-5)', () => {
  it('disables active users with the suspension marker and leaves other disabled users untouched', async () => {
    const partner = await createPartner({ status: 'active' });
    const stamp = Date.now();
    const active1 = await createUser({ partnerId: partner.id, status: 'active', email: `l5-active1-${stamp}@example.com` });
    const active2 = await createUser({ partnerId: partner.id, status: 'active', email: `l5-active2-${stamp}@example.com` });
    // Disabled for some other reason (compromise / off-boarding) → reason NULL.
    const preDisabled = await createUser({ partnerId: partner.id, status: 'disabled', email: `l5-pre-${stamp}@example.com` });

    const disabled = await withSystemDbAccessContext(() =>
      db.transaction((tx) => disablePartnerUsersForSuspension(tx, partner.id)),
    );

    expect(disabled.map((r) => r.id).sort()).toEqual([active1.id, active2.id].sort());
    expect(await readUser(active1.id)).toEqual({ status: 'disabled', disabledReason: 'partner_suspended' });
    expect(await readUser(active2.id)).toEqual({ status: 'disabled', disabledReason: 'partner_suspended' });
    // The pre-disabled user is NOT re-stamped — its reason stays NULL.
    expect(await readUser(preDisabled.id)).toEqual({ status: 'disabled', disabledReason: null });
  });

  it('unsuspend re-enables only suspension-disabled users, leaving the rest disabled', async () => {
    const partner = await createPartner({ status: 'active' });
    const stamp = Date.now();
    const active1 = await createUser({ partnerId: partner.id, status: 'active', email: `l5b-active1-${stamp}@example.com` });
    const active2 = await createUser({ partnerId: partner.id, status: 'active', email: `l5b-active2-${stamp}@example.com` });
    const preDisabled = await createUser({ partnerId: partner.id, status: 'disabled', email: `l5b-pre-${stamp}@example.com` });

    await withSystemDbAccessContext(() =>
      db.transaction((tx) => disablePartnerUsersForSuspension(tx, partner.id)),
    );
    const reEnabled = await withSystemDbAccessContext(() =>
      db.transaction((tx) => reEnableSuspensionDisabledUsers(tx, partner.id)),
    );

    expect(reEnabled.map((r) => r.id).sort()).toEqual([active1.id, active2.id].sort());
    expect(await readUser(active1.id)).toEqual({ status: 'active', disabledReason: null });
    expect(await readUser(active2.id)).toEqual({ status: 'active', disabledReason: null });
    // The user disabled for another reason is left disabled — the bug #917 L-5 fixes.
    expect(await readUser(preDisabled.id)).toEqual({ status: 'disabled', disabledReason: null });
  });
});
