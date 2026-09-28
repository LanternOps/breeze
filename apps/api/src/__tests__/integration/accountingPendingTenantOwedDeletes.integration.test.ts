/**
 * #7289 against real Postgres: a RE-PARKED former `connected` Xero row still
 * carries its accounting_entity_mappings, and `ON DELETE CASCADE` drops them
 * when the pending row is deleted.
 *
 *  - Cancel (the operator's decision) is never blocked, but the payment deletes
 *    those mappings still owed are counted BEFORE the delete, warned, captured
 *    and audited as `accounting.connection.owed_deletes_discarded`, the same
 *    contract as `deleteConnection`. Driven through the real route + real
 *    authMiddleware, so the audit row is the one production writes.
 *  - The reaper (a timer, not a decision) KEEPS a stale row that still owes
 *    payment deletes, and still reaps one whose mappings owe nothing.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The cancel route is MFA step-up gated; the integration client mints mfa:false
// tokens. Precedent: deviceMaintenanceStepUp.integration.test.ts.
vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return { ...actual, ENABLE_2FA: false };
});
vi.mock('../../services/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sentry')>();
  return { ...actual, captureException: vi.fn() };
});

import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections, accountingEntityMappings, auditLogs, invoicePayments, invoices } from '../../db/schema';
import { accountingRoutes } from '../../routes/accounting';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import { reapStalePendingTenants } from '../../services/accounting/accountingTenantSelection';
import { captureException } from '../../services/sentry';
import { createIntegrationTestClient, createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const asSystem = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

// The production mount path: the cancel route is in SELF_MANAGED_DB_CONTEXT_ROUTES
// (matched on /api/v1/...), so authMiddleware opens no ambient DB context for it.
function app() {
  const result = new Hono();
  result.route('/api/v1/accounting', accountingRoutes);
  return result;
}

/** A connected Xero row, then the multi-organisation reconnect that RE-PARKS it — mappings and all. */
async function connectThenRepark(partnerId: string) {
  const connected = await asSystem(() => upsertConnection(db, partnerId, 'xero', {
    realmId: `ten-${partnerId}`, providerConnectionRef: `conn-${partnerId}`, status: 'connected', environment: 'production',
    accessToken: 'at-connected', refreshToken: 'rt-connected',
  }));
  return { connected, repark: () => asSystem(() => upsertConnection(db, partnerId, 'xero', {
    // Not a JWT: no auth-event claim, so the discard makes no remote call.
    accessToken: 'not-a-jwt', refreshToken: 'rt-reconnect',
    accessTokenExpiresAt: new Date(Date.now() + 30 * MINUTE),
    status: 'pending_tenant', environment: 'production',
  })) };
}

/** A plain (recoverable) contact mapping on a real partner-owned organisation. Returns the org id. */
async function seedContactMapping(connectionId: string, partnerId: string): Promise<string> {
  const org = await createOrganization({ partnerId });
  await asSystem(() => db.insert(accountingEntityMappings).values({
    integrationId: connectionId, partnerId,
    breezeEntityType: 'org', breezeEntityId: org.id,
    // 'Customer' is the stored remote type for an org mapping (entity_pair_chk), whatever the provider calls it.
    remoteEntityType: 'Customer', remoteEntityId: `contact-${randomUUID()}`,
    linkStatus: 'confirmed', syncStatus: 'synced',
  }));
  return org.id;
}

/**
 * One plain contact mapping plus two payment mappings that still OWE a delete
 * (the entity-partner guard needs real invoice_payments on a real invoice).
 */
async function seedOwedAndPlain(connectionId: string, partnerId: string) {
  const orgId = await seedContactMapping(connectionId, partnerId);
  await asSystem(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId, orgId, invoiceNumber: `INV-7289-${randomUUID().slice(0, 8)}`, status: 'sent', currencyCode: 'USD',
      issueDate: new Date().toISOString().slice(0, 10), subtotal: '150.00', taxTotal: '0.00', total: '150.00', balance: '150.00',
    }).returning({ id: invoices.id });
    for (const remoteEntityId of ['P-181/INV-145', 'P-182/INV-146']) {
      const [payment] = await db.insert(invoicePayments).values({
        invoiceId: inv!.id, orgId, amount: '10.00', method: 'check', receivedAt: '2026-09-02', recordedBy: null,
      }).returning({ id: invoicePayments.id });
      await db.insert(accountingEntityMappings).values({
        integrationId: connectionId, partnerId,
        breezeEntityType: 'payment', breezeEntityId: payment!.id,
        remoteEntityType: 'Payment', remoteEntityId,
        linkStatus: 'confirmed', syncStatus: 'synced',
        breezeOrigin: true, pendingOp: 'delete', pendingSince: new Date(),
      });
    }
  });
}

async function mappingCount(connectionId: string) {
  const rows = await asSystem(() => db.select({ id: accountingEntityMappings.id }).from(accountingEntityMappings)
    .where(eq(accountingEntityMappings.integrationId, connectionId)));
  return rows.length;
}

async function readRow(id: string) {
  const [row] = await asSystem(() => db.select().from(accountingConnections).where(eq(accountingConnections.id, id)));
  return row ?? null;
}

async function waitForAuditRow(action: string, resourceId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await getTestDb().select().from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId))).limit(1);
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`audit row ${action} for ${resourceId} never appeared`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(captureException).mockClear();
});

describe('#7289 re-parked pending row with mappings (real DB)', () => {
  runDb('cancel of a re-parked row that owes payment deletes: row + mappings gone, owed deletes warned, captured and audited with the count', async () => {
    const client = await createIntegrationTestClient(app(), { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const { connected, repark } = await connectThenRepark(partnerId);
    await seedOwedAndPlain(connected.id, partnerId);
    const parked = await repark();
    expect(parked.id).toBe(connected.id);
    expect(parked.status).toBe('pending_tenant');
    expect(await mappingCount(connected.id)).toBe(3);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
    const warn = vi.spyOn(console, 'warn');

    const res = await client.post('/api/v1/accounting/xero/tenants/cancel');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cancelled: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    // The cancel is never blocked: the row and (by cascade) every mapping are gone.
    expect(await readRow(connected.id)).toBeNull();
    expect(await mappingCount(connected.id)).toBe(0);

    // Counted BEFORE the delete — afterwards there is nothing left to count.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('owed Xero payment delete'),
      expect.objectContaining({ connectionId: connected.id, reason: 'pending_tenant_cancel', count: 2 }),
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('discarded 2 owed Xero payment delete') }),
      undefined,
      expect.objectContaining({ accounting_connection_id: connected.id }),
    );

    const audit = await waitForAuditRow('accounting.connection.owed_deletes_discarded', connected.id);
    expect(audit.resourceType).toBe('accounting_connection');
    expect(audit.result).toBe('failure');
    expect(audit.details).toEqual({
      provider: 'xero', reason: 'tenant_selection_cancelled', count: 2,
      remoteEntityIds: expect.arrayContaining(['P-181/INV-145', 'P-182/INV-146']),
    });
  });

  runDb('the reaper KEEPS a stale re-parked row that owes payment deletes, and still reaps one whose mappings owe nothing', async () => {
    const [owing, plain] = [await createPartner(), await createPartner()];
    const owingRow = await connectThenRepark(owing.id);
    await seedOwedAndPlain(owingRow.connected.id, owing.id);
    await owingRow.repark();
    const plainRow = await connectThenRepark(plain.id);
    await seedContactMapping(plainRow.connected.id, plain.id);
    await plainRow.repark();
    for (const id of [owingRow.connected.id, plainRow.connected.id]) {
      await asSystem(() => db.update(accountingConnections)
        .set({ updatedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(accountingConnections.id, id)));
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
    const warn = vi.spyOn(console, 'warn');

    const out = await reapStalePendingTenants();
    expect(out.kept).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Kept: row still pending, all three mappings (both owed deletes) intact.
    expect((await readRow(owingRow.connected.id))?.status).toBe('pending_tenant');
    expect(await mappingCount(owingRow.connected.id)).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('NOT reaped'),
      expect.objectContaining({ connectionId: owingRow.connected.id, count: 2 }),
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('still owes payment deletes') }),
      undefined,
      expect.objectContaining({ accounting_connection_id: owingRow.connected.id }),
    );
    // No owed delete was discarded, so nothing reports one.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('owed Xero payment delete'),
      expect.objectContaining({ connectionId: owingRow.connected.id }),
    );

    // Reaped: a contact mapping is recoverable (re-adopted on reconnect), so it does not hold the slot.
    expect(await readRow(plainRow.connected.id)).toBeNull();
    expect(await mappingCount(plainRow.connected.id)).toBe(0);
  });
});
