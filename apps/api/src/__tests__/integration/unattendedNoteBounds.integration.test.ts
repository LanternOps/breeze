/**
 * Real-PostgreSQL proof for the unattended device-note bound (#12140,
 * deviceNoteBounds.ts) as breeze_app: the locked recount in
 * `createDeviceContext` holds when calls run in parallel, each in its own
 * request transaction, as parallel MCP tool calls do.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { brainDeviceContext } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { createDeviceContext } from '../../services/brainDeviceContext';
import {
  UNATTENDED_NOTE_ACTIVE_LIMIT_MESSAGE,
  UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE,
  UNATTENDED_NOTE_MAX_DETAILS_CHARS,
  UNATTENDED_NOTE_MAX_EXPIRY_DAYS,
} from '../../services/deviceNoteBounds';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

function orgAuth(orgId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    orgCondition: (col: unknown) => sql`${col} = ${orgId}` as SQL,
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

const inOrg = <T>(orgId: string, fn: () => Promise<T>) =>
  withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn);

const in30Days = () => new Date(Date.now() + 30 * 86_400_000);

function unattendedWrite(orgId: string, deviceId: string, auth: AuthContext, i: number) {
  return inOrg(orgId, () =>
    createDeviceContext(deviceId, 'quirk', `parallel note ${i}`, null, auth, in30Days(), { unattended: true }),
  );
}

async function activeNotesOn(deviceId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: brainDeviceContext.id, resolvedAt: brainDeviceContext.resolvedAt, expiresAt: brainDeviceContext.expiresAt })
    .from(brainDeviceContext)
    .where(eq(brainDeviceContext.deviceId, deviceId));
  const now = Date.now();
  return rows.filter((r) => r.resolvedAt === null && (r.expiresAt === null || r.expiresAt.getTime() > now)).length;
}

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  return { org, device };
}

describe('unattended note bound on a real Postgres (breeze_app)', () => {
  it(`parallel unattended notes on one device stop at ${UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE} active`, async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);

    const results = await Promise.all(
      Array.from({ length: UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE + 6 }, (_, i) => unattendedWrite(org.id, device.id, auth, i)),
    );

    const refused = results.filter((r) => 'error' in r);
    expect(results.filter((r) => !('error' in r))).toHaveLength(UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE);
    expect(refused.every((r) => (r as { error: string }).error === UNATTENDED_NOTE_ACTIVE_LIMIT_MESSAGE)).toBe(true);
    expect(await activeNotesOn(device.id)).toBe(UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE);
  });

  it('resolved and expired notes do not count as active', async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await getTestDb().insert(brainDeviceContext).values([
      ...Array.from({ length: UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE - 1 }, (_, i) => ({
        orgId: org.id, deviceId: device.id, contextType: 'issue' as const, summary: `older ${i}`, createdAt: old,
      })),
      { orgId: org.id, deviceId: device.id, contextType: 'issue' as const, summary: 'resolved', createdAt: old, resolvedAt: old },
      { orgId: org.id, deviceId: device.id, contextType: 'issue' as const, summary: 'expired', createdAt: old, expiresAt: new Date(Date.now() - 86_400_000) },
    ]);

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => unattendedWrite(org.id, device.id, auth, i)),
    );

    expect(results.filter((r) => !('error' in r))).toHaveLength(1);
    expect(await activeNotesOn(device.id)).toBe(UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE);
  });

  it('the flag reaches the handler and service through the real executeTool', async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);
    const run = (input: Record<string, unknown>) => inOrg(org.id, () => executeTool(
      'set_device_context',
      { deviceId: device.id, contextType: 'quirk', summary: 'through dispatch', ...input },
      auth,
      { context: { unattendedNoteWrite: true } },
    ));

    const tooLarge = await run({ details: { n: 'x'.repeat(UNATTENDED_NOTE_MAX_DETAILS_CHARS) } });
    expect(JSON.parse(tooLarge).error).toContain(String(UNATTENDED_NOTE_MAX_DETAILS_CHARS));
    expect(await activeNotesOn(device.id)).toBe(0);

    const before = Date.now();
    expect(await run({})).toContain(`expires in ${UNATTENDED_NOTE_MAX_EXPIRY_DAYS} days`);
    const [row] = await getTestDb().select().from(brainDeviceContext).where(eq(brainDeviceContext.deviceId, device.id));
    expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + (UNATTENDED_NOTE_MAX_EXPIRY_DAYS * 86_400_000) - 1_000);
    expect(row!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + (UNATTENDED_NOTE_MAX_EXPIRY_DAYS * 86_400_000) + 1_000);
  });

  it('a note without the unattended flag is not held to the bound', async () => {
    const { org, device } = await fixture();
    const auth = orgAuth(org.id);
    for (let i = 0; i < UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE; i++) {
      await unattendedWrite(org.id, device.id, auth, i);
    }

    const approved = await inOrg(org.id, () => createDeviceContext(device.id, 'issue', 'approved in the app', null, auth));

    expect(approved).not.toHaveProperty('error');
    expect(await activeNotesOn(device.id)).toBe(UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE + 1);
  });
});
