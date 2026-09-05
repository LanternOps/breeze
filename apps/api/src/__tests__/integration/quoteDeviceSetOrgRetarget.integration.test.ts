/**
 * #3205 W05 decision 7. Two claims, tested separately because they behave
 * differently and both are easy to get wrong:
 *
 *  - the retarget SUCCEEDS at all. Without the named
 *    `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED` this is a 23503: the
 *    parent UPDATE quotes runs before the children's, and the FK is checked at
 *    end-of-statement. That regression is the reason this file exists.
 *  - an UNSCOPED descriptor is re-derived in the target org; a SCOPED one is
 *    cleared, keeps its stamp, is flagged, and has its quantity LEFT ALONE.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, quotes, quoteBlocks, quoteLines } from '../../db/schema';
import { updateQuote, cloneQuote, reviseQuote, getQuote } from '../../services/quoteService';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ACTOR = (partnerId: string, orgIds: string[] | null = null) => ({
  userId: null,
  partnerId,
  accessibleOrgIds: orgIds,
});

/** Org A has 2 servers, org B has 5 — so a CARRIED count and a RE-DERIVED one
 *  are distinguishable, which is the only way this assertion means anything. */
async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `RT ${sfx}`, slug: `rt-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'RA', slug: `ra-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'RB', slug: `rb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [sA] = await db.insert(sites).values({ orgId: oA!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [sB] = await db.insert(sites).values({ orgId: oB!.id, name: `Austin ${sfx}` }).returning({ id: sites.id });
    const mk = (orgId: string, siteId: string, n: number) => Array.from({ length: n }, (_, i) => ({
      orgId, siteId, agentId: `${orgId}-${i}-${sfx}`, hostname: `h${i}`, status: 'online' as const,
      osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1', deviceRole: 'server' as const,
    }));
    await db.insert(devices).values([...mk(oA!.id, sA!.id, 2), ...mk(oB!.id, sB!.id, 5)] as never);
    const [g] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `VIP ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    const [q] = await db.insert(quotes).values({ partnerId: p!.id, orgId: oA!.id, quoteNumber: `Q-RT-${sfx}`, currencyCode: 'USD', status: 'draft' }).returning({ id: quotes.id });
    const [blk] = await db.insert(quoteBlocks).values({ quoteId: q!.id, orgId: oA!.id, blockType: 'line_items', content: {} }).returning({ id: quoteBlocks.id });
    const [unscoped, scopedGroup, scopedSite] = await db.insert(quoteLines).values([
      { quoteId: q!.id, orgId: oA!.id, blockId: blk!.id, sourceType: 'manual', name: 'Servers', quantity: '2.00', unitPrice: '40.00', taxable: false, recurrence: 'monthly', lineTotal: '80.00', contractLineType: 'per_device_role', deviceRoles: ['server'], includedQuantity: '25.00', overageMode: 'flag' },
      { quoteId: q!.id, orgId: oA!.id, blockId: blk!.id, sourceType: 'manual', name: 'VIP', quantity: '7.00', unitPrice: '10.00', taxable: false, recurrence: 'monthly', lineTotal: '70.00', contractLineType: 'per_device_group', deviceGroupId: g!.id, deviceGroupName: g!.name },
      { quoteId: q!.id, orgId: oA!.id, blockId: blk!.id, sourceType: 'manual', name: 'Dallas', quantity: '2.00', unitPrice: '5.00', taxable: false, recurrence: 'monthly', lineTotal: '10.00', contractLineType: 'per_device', siteId: sA!.id, siteName: sA!.name },
    ] as never).returning({ id: quoteLines.id });
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, group: g!, site: sA!, quoteId: q!.id, unscoped: unscoped!.id, scopedGroup: scopedGroup!.id, scopedSite: scopedSite!.id };
  });
}

describe('quote org retarget with device-set lines (#3205 W05)', () => {
  // THE REGRESSION. Drop the named deferral and this is a 23503.
  runDb('succeeds and moves every child org_id', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => updateQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId, [f.orgA, f.orgB])));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ orgId: quoteLines.orgId }).from(quoteLines).where(eq(quoteLines.quoteId, f.quoteId)));
    expect(rows.every((r) => r.orgId === f.orgB)).toBe(true);
  });

  runDb('an UNSCOPED descriptor keeps its roles and allowance and is RE-DERIVED in the target org', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => updateQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId, [f.orgA, f.orgB])));
    const [l] = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.id, f.unscoped)));
    // Five servers are counted in org B, not the two in org A. The committed
    // allowance contract persists the fixed 25-unit base quantity.
    expect(l).toMatchObject({ quantity: '25.00', deviceRoles: ['server'], includedQuantity: '25.00', overageMode: 'flag' });
  });

  runDb('a SCOPED descriptor is cleared, keeps its stamp, is flagged, and keeps its quantity EXACTLY', async () => {
    const f = await seed();
    const res = await withSystemDbAccessContext(() => updateQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId, [f.orgA, f.orgB])));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, f.quoteId)));
    const group = rows.find((r) => r.id === f.scopedGroup)!;
    const site = rows.find((r) => r.id === f.scopedSite)!;
    // Never re-derived (the descriptor is incomplete, so any number is a
    // fiction) and never zeroed (a stale count that reads as authoritative is
    // the silent failure this wave removes).
    expect(group).toMatchObject({ deviceGroupId: null, deviceGroupName: f.group.name, quantity: '7.00' });
    expect(site).toMatchObject({ siteId: null, siteName: f.site.name, quantity: '2.00' });
    expect(res.deviceSetDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineId: f.scopedGroup, reason: 'org_retargeted' }),
      expect.objectContaining({ lineId: f.scopedSite, reason: 'org_retargeted' }),
    ]));
    const read = await withSystemDbAccessContext(() => getQuote(f.quoteId, ACTOR(f.partnerId, [f.orgB])));
    expect(read.lines.find((l) => l.id === f.scopedGroup)).toMatchObject({ descriptorUnresolved: true });
  });

  runDb('a retargeted clone behaves identically', async () => {
    const f = await seed();
    const cloned = await withSystemDbAccessContext(() => cloneQuote(f.quoteId, ACTOR(f.partnerId, [f.orgA, f.orgB]), { orgId: f.orgB }));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, cloned.id)));
    expect(rows.find((r) => r.contractLineType === 'per_device_role')).toMatchObject({ quantity: '25.00' });
    expect(rows.find((r) => r.contractLineType === 'per_device_group')).toMatchObject({ deviceGroupId: null, deviceGroupName: f.group.name, quantity: '7.00' });
    expect(cloned.deviceSetDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'org_retargeted' }),
    ]));
  });

  runDb('a same-org clone and a revision carry every descriptor column AND the quantity verbatim', async () => {
    const f = await seed();
    const actor = ACTOR(f.partnerId, [f.orgA, f.orgB]);
    const cloned = await withSystemDbAccessContext(() => cloneQuote(f.quoteId, actor, {}));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, cloned.id)));
    expect(rows.find((r) => r.contractLineType === 'per_device_group')).toMatchObject({
      contractLineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: f.group.id, deviceGroupName: f.group.name,
      siteId: null, siteName: null, includedQuantity: null,
      overageMode: null, overageUnitPrice: null, quantity: '7.00',
    });
    // A revision that only changes terms must not silently move money.
    await withSystemDbAccessContext(() => db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, f.quoteId)));
    const rev = await withSystemDbAccessContext(() => reviseQuote(f.quoteId, actor));
    const revRows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, rev.id)));
    expect(revRows.find((r) => r.contractLineType === 'per_device_role')).toMatchObject({
      contractLineType: 'per_device_role', deviceRoles: ['server'],
      deviceGroupId: null, deviceGroupName: null, siteId: null, siteName: null,
      includedQuantity: '25.00', overageMode: 'flag', overageUnitPrice: null,
      quantity: '2.00',
    });
    await expect(withSystemDbAccessContext(() => updateQuote(rev.id, { orgId: f.orgB }, actor)))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});
