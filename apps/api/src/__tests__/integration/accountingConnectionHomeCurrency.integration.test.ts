/**
 * Real-DB proof for the accounting home-currency compare-and-set (#3780, B8).
 *
 * `updateHomeCurrency` (services/accounting/accountingConnectionService.ts) is a
 * realm-generation compare-and-set under a single-row `FOR UPDATE`. Four of its
 * properties CANNOT be proven with Drizzle mocks:
 *
 *  - the locking SELECT is subject to the same partner-axis RLS policy as the
 *    write, so a wrong DB context aborts loudly instead of silently no-op'ing;
 *  - a stale `updated_at` really does fail to match a live row;
 *  - two reconnects that land in the SAME millisecond share an application
 *    stamped `updated_at`, so only the realm id can distinguish them — this is
 *    the race a timestamp-only predicate lets through;
 *  - `home_currency` has NO FK to `supported_currencies` and no
 *    `currencyCodeSchema` gate, so a realm reporting a code outside Breeze's
 *    curated 34 (e.g. BHD) still persists.
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests, so a memoized fixture would be stale and vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import { encryptSecret } from '../../services/secretCrypto';
import {
  updateHomeCurrency,
  upsertConnection,
  type DbTransactor,
} from '../../services/accounting/accountingConnectionService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// The proxied request-scoped client satisfies the service's structural seam.
const transactor = db as unknown as DbTransactor;

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

/** Seeds a partner + a connected quickbooks connection exactly as production writes it. */
async function seedConnection(realmId: string) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const conn = await upsertConnection(db, partner.id, 'quickbooks', {
      realmId,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      environment: 'production',
      homeCurrency: null,
    });
    return { partner, conn };
  });
}

async function readConnection(connectionId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(accountingConnections)
      .where(eq(accountingConnections.id, connectionId))
      .limit(1);
    return row;
  });
}

describe('accounting_connections home currency — compare-and-set against real Postgres', () => {
  // Non-vacuity guard: if the code-under-test pool were ever a BYPASSRLS role
  // (e.g. a worktree missing its .env.test symlink), the partner-isolation case
  // below would pass with broken policies. Fail loudly here first.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const rows = await withDbAccessContext(partnerCtx(partner.id), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  runDb('persists the captured home currency (normalized) under a system context', async () => {
    const { partner, conn } = await seedConnection('realm-A');
    expect(conn.updatedAt).toBeInstanceOf(Date);

    await withSystemDbAccessContext(() =>
      updateHomeCurrency(
        transactor,
        conn.id,
        partner.id,
        { updatedAt: conn.updatedAt as Date, realmId: 'realm-A' },
        'cad'
      )
    );

    const after = await readConnection(conn.id);
    expect(after?.homeCurrency).toBe('CAD');
  });

  runDb('rejects a stale updatedAt and leaves home_currency untouched', async () => {
    const { partner, conn } = await seedConnection('realm-A');
    const captured = conn.updatedAt as Date;

    // An unrelated write bumps the generation between capture and persist.
    await withSystemDbAccessContext(() =>
      db
        .update(accountingConnections)
        .set({ updatedAt: new Date(captured.getTime() + 1000), lastError: 'unrelated churn' })
        .where(eq(accountingConnections.id, conn.id))
    );

    await expect(
      withSystemDbAccessContext(() =>
        updateHomeCurrency(
          transactor,
          conn.id,
          partner.id,
          { updatedAt: captured, realmId: 'realm-A' },
          'CAD'
        )
      )
    ).rejects.toThrow(/matched no accounting_connections row/);

    const after = await readConnection(conn.id);
    expect(after?.homeCurrency).toBeNull();
  });

  runDb('aborts a same-millisecond reconnect to a DIFFERENT realm', async () => {
    const { partner, conn } = await seedConnection('realm-A');
    const captured = conn.updatedAt as Date;

    // Reproduce the degenerate race deterministically: the (partner, provider)
    // row is reconnected to realm B while `updated_at` keeps the IDENTICAL
    // application-stamped value, which is exactly what two upserts inside one
    // millisecond produce. A timestamp-only predicate would accept realm A's
    // late capture here and mis-stamp realm B's ledger currency.
    await withSystemDbAccessContext(() =>
      db
        .update(accountingConnections)
        .set({ realmIdEncrypted: encryptSecret('realm-B'), updatedAt: captured })
        .where(eq(accountingConnections.id, conn.id))
    );

    await expect(
      withSystemDbAccessContext(() =>
        updateHomeCurrency(
          transactor,
          conn.id,
          partner.id,
          { updatedAt: captured, realmId: 'realm-A' },
          'CAD'
        )
      )
    ).rejects.toThrow(/different realm/i);

    expect((await readConnection(conn.id))?.homeCurrency).toBeNull();

    // …and the row is still writable for the realm that actually owns it now.
    await withSystemDbAccessContext(() =>
      updateHomeCurrency(
        transactor,
        conn.id,
        partner.id,
        { updatedAt: captured, realmId: 'realm-B' },
        'CAD'
      )
    );
    expect((await readConnection(conn.id))?.homeCurrency).toBe('CAD');
  });

  runDb('partner A cannot capture a currency onto partner B\'s connection (RLS hides the locking read)', async () => {
    const { partner: partnerB, conn } = await seedConnection('realm-B');
    const partnerA = await withSystemDbAccessContext(() => createPartner());

    await expect(
      withDbAccessContext(partnerCtx(partnerA.id), () =>
        updateHomeCurrency(
          transactor,
          conn.id,
          partnerB.id,
          { updatedAt: conn.updatedAt as Date, realmId: 'realm-B' },
          'CAD'
        )
      )
    ).rejects.toThrow(/matched no accounting_connections row/);

    const after = await readConnection(conn.id);
    expect(after?.homeCurrency).toBeNull();
  });

  runDb('the owning partner CAN capture inside its own partner context (proves the isolation case is not vacuous)', async () => {
    const { partner, conn } = await seedConnection('realm-A');

    await withDbAccessContext(partnerCtx(partner.id), () =>
      updateHomeCurrency(
        transactor,
        conn.id,
        partner.id,
        { updatedAt: conn.updatedAt as Date, realmId: 'realm-A' },
        'CAD'
      )
    );

    const after = await readConnection(conn.id);
    expect(after?.homeCurrency).toBe('CAD');
  });

  runDb('persists a currency outside Breeze\'s curated list (no FK, no currencyCodeSchema gate)', async () => {
    const { partner, conn } = await seedConnection('realm-A');

    await withSystemDbAccessContext(() =>
      updateHomeCurrency(
        transactor,
        conn.id,
        partner.id,
        { updatedAt: conn.updatedAt as Date, realmId: 'realm-A' },
        'BHD'
      )
    );

    const after = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ homeCurrency: accountingConnections.homeCurrency })
        .from(accountingConnections)
        .where(and(
          eq(accountingConnections.id, conn.id),
          eq(accountingConnections.partnerId, partner.id)
        ))
        .limit(1);
      return row;
    });
    expect(after?.homeCurrency).toBe('BHD');
  });
});
