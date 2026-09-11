import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contractLines, contracts, invoiceLines, organizations, partners, sites } from '../../db/schema';
import {
  addContractLine,
  createManualInvoice,
  lockContractLineMaterializationSource,
} from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { getTestDb } from './setup';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL_APP);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID().slice(0, 8);
    const [partner] = await db.insert(partners).values({
      name: `Contract materialization ${suffix}`,
      slug: `contract-materialization-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
    }).returning({ id: partners.id });
    const orgRows = await db.insert(organizations).values([
      { partnerId: partner!.id, name: `Visible ${suffix}`, slug: `visible-${suffix}`, currencyCode: 'USD' },
      { partnerId: partner!.id, name: `Sibling ${suffix}`, slug: `sibling-${suffix}`, currencyCode: 'USD' },
    ]).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: orgRows[0]!.id, name: 'Visible site' })
      .returning({ id: sites.id });
    const contractRows = await db.insert(contracts).values(orgRows.map((org, index) => ({
      partnerId: partner!.id,
      orgId: org.id,
      name: `Contract ${index}`,
      status: 'active' as const,
      intervalMonths: 1,
      startDate: '2026-09-01',
      currencyCode: 'USD',
      billingTiming: 'advance' as const,
    }))).returning({ id: contracts.id, orgId: contracts.orgId });
    const [line] = await db.insert(contractLines).values({
      contractId: contractRows[0]!.id,
      orgId: orgRows[0]!.id,
      lineType: 'flat',
      description: 'Synthetic managed service',
      manualQuantity: '1.00',
      unitPrice: '10.00',
      taxable: false,
    }).returning({ id: contractLines.id });
    const actor: InvoiceActor = {
      userId: null,
      partnerId: partner!.id,
      accessibleOrgIds: orgRows.map((org) => org.id),
    };
    const invoice = await createManualInvoice({ orgId: orgRows[0]!.id, siteId: site!.id }, actor);
    return { partnerId: partner!.id, orgs: orgRows, siteId: site!.id, contracts: contractRows, lineId: line!.id, invoiceId: invoice.id, actor };
  });
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

async function waitUntilBlocked(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await getTestDb().execute<{ blocked: number }>(sql`
      SELECT count(*)::int AS blocked
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
    `);
    if ((rows[0]?.blocked ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('contract-line writer did not reach the invoice lock barrier');
}

describe.skipIf(!SHOULD_RUN)('contract-line materialization authority and lock order', () => {
  it('authorizes the exact invoice/source pair and rejects site-restricted and cross-org pairs before writes', async () => {
    const fixture = await seed();
    const context = partnerContext(fixture.partnerId, fixture.orgs.map((org) => org.id));

    await withDbAccessContext(context, () => db.transaction(async () => {
      const locked = await lockContractLineMaterializationSource(
        fixture.invoiceId, fixture.contracts[0]!.id, fixture.actor,
      );
      expect(locked.invoice.orgId).toBe(fixture.orgs[0]!.id);
      expect(locked.contract.orgId).toBe(fixture.orgs[0]!.id);
    }));

    await expect(withDbAccessContext(context, () => db.transaction(() =>
      lockContractLineMaterializationSource(
        fixture.invoiceId,
        fixture.contracts[0]!.id,
        { ...fixture.actor, allowedSiteIds: [] },
      ),
    ))).rejects.toMatchObject({ code: 'SITE_DENIED' });

    await expect(withDbAccessContext(context, () => db.transaction(() =>
      lockContractLineMaterializationSource(
        fixture.invoiceId, fixture.contracts[1]!.id, fixture.actor,
      ),
    ))).rejects.toMatchObject({ status: 404, code: 'INVALID_STATE' });

    const persisted = await withSystemDbAccessContext(() => db.select({ id: invoiceLines.id })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, fixture.invoiceId)));
    expect(persisted).toEqual([]);
  });

  it('shares invoice-to-contract ordering with addContractLine without deadlocking', async () => {
    const fixture = await seed();
    const context = partnerContext(fixture.partnerId, fixture.orgs.map((org) => org.id));
    const held = deferred();
    const release = deferred();
    let holderPid = 0;

    const holder = withDbAccessContext(context, () => db.transaction(async () => {
      const rows = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      holderPid = rows[0]!.pid;
      await lockContractLineMaterializationSource(
        fixture.invoiceId, fixture.contracts[0]!.id, fixture.actor,
      );
      held.resolve();
      await release.promise;
    }));

    await held.promise;
    const writer = withDbAccessContext(context, () => addContractLine(fixture.invoiceId, {
      description: 'Synthetic managed service',
      quantity: '1.00',
      unitPrice: '10.00',
      taxable: false,
      sourceId: fixture.lineId,
      contractId: fixture.contracts[0]!.id,
    }, fixture.actor));
    try {
      await waitUntilBlocked(holderPid);
    } finally {
      // Never strand the lock-holder if the pg_blocking_pids assertion fails.
      release.resolve();
      await holder;
    }
    await expect(writer).resolves.toMatchObject({ line: { sourceContractId: fixture.contracts[0]!.id } });

    const persisted = await withSystemDbAccessContext(() => db.select({ id: invoiceLines.id })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, fixture.invoiceId)));
    expect(persisted).toHaveLength(1);
  });
});
