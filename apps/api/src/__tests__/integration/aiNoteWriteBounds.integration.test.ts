/**
 * Real-PostgreSQL proof for the card-free note bounds (aiNoteWrites.ts) as
 * breeze_app: the handler's locked recount holds when calls run in parallel,
 * and the gate's device read checks access before it counts anything.
 *
 * The chat gate counts a device's notes before any of a turn's parallel calls
 * has written, so all of them can pass it. `createDeviceContext` with
 * `cardFree` counts again under a per-device advisory lock held until the
 * insert's transaction commits, so the device bounds hold however many calls
 * race.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { brainDeviceContext } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  createDeviceContext,
  readCardFreeNoteBudget,
} from '../../services/brainDeviceContext';
import {
  NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE,
  NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY,
  NOTE_WRITE_NEEDS_APPROVAL_MESSAGE,
} from '../../services/aiNoteWrites';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

function orgAuth(orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    orgCondition: (col: unknown) => sql`${col} = ${orgId}` as SQL,
    canAccessOrg: (id: string) => id === orgId,
    ...(allowedSiteIds
      ? { allowedSiteIds, canAccessSite: (siteId: string | null) => siteId !== null && allowedSiteIds.includes(siteId) }
      : {}),
  } as unknown as AuthContext;
}

const inOrg = <T>(orgId: string, fn: () => Promise<T>) =>
  withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn);

const in30Days = () => new Date(Date.now() + 30 * 86_400_000);

/** One card-free write in its own request transaction, as a parallel tool call runs. */
function cardFreeWrite(orgId: string, deviceId: string, auth: AuthContext, i: number) {
  return inOrg(orgId, () =>
    createDeviceContext(deviceId, 'quirk', `parallel note ${i}`, null, auth, in30Days(), { cardFree: true }),
  );
}

async function notesOn(deviceId: string): Promise<number> {
  const rows = await getTestDb().select({ id: brainDeviceContext.id }).from(brainDeviceContext).where(eq(brainDeviceContext.deviceId, deviceId));
  return rows.length;
}

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const outOfSite = await createDevice({ orgId: org.id, siteId: otherSite.id });
  return { org, site, device, outOfSite };
}

describe('card-free note bounds on a real Postgres (breeze_app)', () => {
  it(`parallel card-free notes on one device stop at ${NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY} in 24 h`, async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => cardFreeWrite(org.id, device.id, auth, i)),
    );

    const written = results.filter((r) => !('error' in r));
    const refused = results.filter((r) => 'error' in r);
    expect(written).toHaveLength(NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY);
    expect(refused.every((r) => (r as { error: string }).error === NOTE_WRITE_NEEDS_APPROVAL_MESSAGE)).toBe(true);
    expect(await notesOn(device.id)).toBe(NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY);
  });

  it(`parallel card-free notes stop at ${NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE} active notes; resolved and expired ones do not count`, async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);
    const old = new Date(Date.now() - 3 * 86_400_000);
    // Seven active notes from before the 24 h window, plus one resolved and one
    // expired that must not count as active.
    await getTestDb().insert(brainDeviceContext).values([
      ...Array.from({ length: NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE - 1 }, (_, i) => ({
        orgId: org.id, deviceId: device.id, contextType: 'issue' as const, summary: `older ${i}`, createdAt: old,
      })),
      { orgId: org.id, deviceId: device.id, contextType: 'issue' as const, summary: 'resolved', createdAt: old, resolvedAt: old },
      { orgId: org.id, deviceId: device.id, contextType: 'issue' as const, summary: 'expired', createdAt: old, expiresAt: new Date(Date.now() - 86_400_000) },
    ]);

    await expect(inOrg(org.id, () => readCardFreeNoteBudget(device.id, auth)))
      .resolves.toEqual({ active: NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE - 1, recent: 0 });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => cardFreeWrite(org.id, device.id, auth, i)),
    );

    expect(results.filter((r) => !('error' in r))).toHaveLength(1);
    await expect(inOrg(org.id, () => readCardFreeNoteBudget(device.id, auth)))
      .resolves.toEqual({ active: NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE, recent: 1 });
  });

  it('an approved (card) note is not held to the bounds', async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);
    for (let i = 0; i < NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY; i++) {
      await cardFreeWrite(org.id, device.id, auth, i);
    }

    const approved = await inOrg(org.id, () => createDeviceContext(device.id, 'issue', 'approved on a card', null, auth));

    expect(approved).not.toHaveProperty('error');
  });

  it('a card-free note with no expiry, or one past the cap, writes nothing', async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);

    const none = await inOrg(org.id, () => createDeviceContext(device.id, 'quirk', 'no expiry', null, auth, undefined, { cardFree: true }));
    const long = await inOrg(org.id, () => createDeviceContext(device.id, 'quirk', 'long', null, auth, new Date(Date.now() + 31 * 86_400_000), { cardFree: true }));

    expect(none).toEqual({ error: NOTE_WRITE_NEEDS_APPROVAL_MESSAGE });
    expect(long).toEqual({ error: NOTE_WRITE_NEEDS_APPROVAL_MESSAGE });
    expect(await notesOn(device.id)).toBe(0);
  });

  it('the gate read answers null for a device outside the caller\'s sites, whatever its notes', async () => {
    const { org, site, outOfSite } = await fixture();
    await getTestDb().insert(brainDeviceContext).values(
      Array.from({ length: NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE }, (_, i) => ({
        orgId: org.id, deviceId: outOfSite.id, contextType: 'issue' as const, summary: `hidden ${i}`,
      })),
    );
    const siteRestricted = orgAuth(org.id, [site.id]);

    await expect(inOrg(org.id, () => readCardFreeNoteBudget(outOfSite.id, siteRestricted))).resolves.toBeNull();
    // An org-wide caller reaches it and sees the counts.
    await expect(inOrg(org.id, () => readCardFreeNoteBudget(outOfSite.id, orgAuth(org.id))))
      .resolves.toEqual({ active: NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE, recent: NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE });
  });

  it('the gate read answers null for another org\'s device', async () => {
    const { device } = await fixture();
    const partner = await createPartner();
    const other = await createOrganization({ partnerId: partner.id });

    await expect(inOrg(other.id, () => readCardFreeNoteBudget(device.id, orgAuth(other.id)))).resolves.toBeNull();
  });
});
