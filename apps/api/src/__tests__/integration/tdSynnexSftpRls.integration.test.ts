/**
 * Functional cross-partner forge proof for the TD SYNNEX nightly SFTP P&A
 * tables (`td_synnex_sftp_integrations`, `td_synnex_price_availability`).
 *
 * Migration under test: 2026-07-16-td-synnex-sftp-price-file.sql
 *
 * Both tables are Shape 3 (partner-axis). Policy (FOR ALL TO breeze_app,
 * USING + WITH CHECK):
 *   public.breeze_current_scope() = 'system'
 *     OR public.breeze_has_partner_access(partner_id)
 *
 * The rls-coverage contract test only proves *a* policy naming the right helper
 * exists on the right column — it cannot prove the scoping actually holds at
 * runtime. This suite is the functional proof: it runs through the REAL
 * postgres.js driver, whose pool connects as the unprivileged `breeze_app` role
 * (rolbypassrls = false, FORCE ROW LEVEL SECURITY — see setup.ts), so RLS is
 * genuinely enforced and these assertions are NOT vacuous.
 *
 * A harness self-check (first test below) asserts, from inside the same
 * connection the forges run on, that (a) the session role really is breeze_app
 * and (b) breeze_current_scope()/breeze_has_partner_access() actually evaluate
 * to the partner-A context — i.e. a forge that "passes" is passing because the
 * policy rejected it, not because the fixture never set a context or the pool
 * quietly connected as the superuser (the memoized-fixture / worktree-.env.test
 * vacuous-green traps).
 *
 * It proves, as the app role:
 *   1. same-partner INSERT + SELECT works for both tables (happy path)
 *   2. cross-partner INSERT (partner A forging a partner-B row) is rejected
 *      with SQLSTATE 42501 for both tables (WITH CHECK)
 *   3. a partner-B row (seeded via system scope) is invisible to a partner-A
 *      SELECT for both tables (USING)
 *   4. system scope — the nightly ingest worker's context — CAN write rows for
 *      any partner, and cross-partner UPDATE/DELETE under partner scope is a
 *      silent 0-row no-op (USING filters the target rows away)
 *
 * postgres.js surfaces the policy error on `.cause` (drizzle wraps the
 * top-level message as "Failed query: ..."), so RLS rejections are matched on
 * the cause's `code`/`message` (same convention as emailInboundRls /
 * customerEmailDomainsRls).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { tdSynnexSftpIntegrations, tdSynnexPriceAvailability } from '../../db/schema/catalog';
import { organizations, partners } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

/**
 * Seeds two unrelated partners (each with an org so accessibleOrgIds is
 * non-empty, mirroring a real partner-scope token) as the privileged test role,
 * which bypasses RLS. Partner A is the "attacker"; partner B is the victim.
 *
 * Deliberately NOT memoized: every test seeds fresh partners against the real
 * DB, so a forge can never "pass" against a stale/absent fixture (#rls-forge
 * memoized-fixture vacuous-pass trap). setup.ts TRUNCATE-CASCADEs the core
 * tenant tables on beforeEach anyway, which would invalidate a cached fixture.
 */
async function seedTwoPartners() {
  const a = await createPartner();
  const aOrg = await createOrganization({ partnerId: a.id });
  const b = await createPartner();
  const bOrg = await createOrganization({ partnerId: b.id });

  seededPartnerIds.push(a.id, b.id);
  seededOrgIds.push(aOrg.id, bOrg.id);

  const partnerAContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [aOrg.id],
    accessiblePartnerIds: [a.id],
    userId: null,
  };

  return { a, aOrg, b, bOrg, partnerAContext };
}

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type PgCause = { code?: string; message?: string };

/**
 * Runs `fn` and returns the driver-level postgres error (postgres.js puts it on
 * `.cause`; drizzle rewraps the message). Returns undefined when nothing threw
 * — which for a forge means an isolation hole, and the caller asserts on it.
 */
async function captureRlsError(fn: () => Promise<unknown>): Promise<PgCause | undefined> {
  try {
    await fn();
    return undefined; // no throw = isolation hole
  } catch (err) {
    return (err as { cause?: PgCause } | undefined)?.cause;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // FK order: td_synnex_* (FK partner_id) → orgs → partners.
  await adminDb
    .delete(tdSynnexPriceAvailability)
    .where(sql`${tdSynnexPriceAvailability.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(tdSynnexSftpIntegrations)
    .where(sql`${tdSynnexSftpIntegrations.partnerId} IN (${partnerList})`);
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  }
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('TD SYNNEX SFTP P&A RLS — partner-axis forge (breeze_app role)', () => {
  it('harness self-check: the forge connection really is breeze_app with the partner-A context set', async () => {
    const { a, b, partnerAContext } = await seedTwoPartners();

    const rows = await withDbAccessContext(partnerAContext, () =>
      db.execute(sql`
        SELECT current_user::text                              AS role_name,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls,
               public.breeze_current_scope()                   AS scope,
               public.breeze_has_partner_access(${a.id}::uuid) AS has_a,
               public.breeze_has_partner_access(${b.id}::uuid) AS has_b,
               (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'td_synnex_sftp_integrations'::regclass) AS force_sftp,
               (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'td_synnex_price_availability'::regclass) AS force_pa
      `)
    );

    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    expect(row).toBeDefined();

    // If any of these is wrong, every "forge rejected" assertion below would be
    // vacuous (superuser pool, missing context, or RLS not forced on the table).
    expect(row?.role_name).toBe('breeze_app');
    expect(row?.bypass_rls).toBe(false);
    expect(row?.scope).toBe('partner');
    expect(row?.has_a).toBe(true);
    expect(row?.has_b).toBe(false);
    expect(row?.force_sftp).toBe(true);
    expect(row?.force_pa).toBe(true);
  });

  it('allows partner A to INSERT + SELECT its own td_synnex_sftp_integrations row', async () => {
    const { a, partnerAContext } = await seedTwoPartners();

    const inserted = await withDbAccessContext(partnerAContext, () =>
      db
        .insert(tdSynnexSftpIntegrations)
        .values({
          partnerId: a.id,
          region: 'US',
          accountNumber: `acct-${uniqueSuffix()}`.slice(0, 32),
          credentials: { password: 'enc:test' },
          enabled: true,
        })
        .returning({ id: tdSynnexSftpIntegrations.id })
    );
    expect(inserted[0]?.id).toBeDefined();

    const readBack = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: tdSynnexSftpIntegrations.id, partnerId: tdSynnexSftpIntegrations.partnerId })
        .from(tdSynnexSftpIntegrations)
        .where(eq(tdSynnexSftpIntegrations.partnerId, a.id))
    );
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.partnerId).toBe(a.id);
  });

  it('allows partner A to INSERT + SELECT its own td_synnex_price_availability row', async () => {
    const { a, partnerAContext } = await seedTwoPartners();

    const sku = `SKU-${uniqueSuffix()}`.slice(0, 64);
    const inserted = await withDbAccessContext(partnerAContext, () =>
      db
        .insert(tdSynnexPriceAvailability)
        .values({
          partnerId: a.id,
          synnexSku: sku,
          mfgPartNo: 'MFG-1',
          name: 'Test widget',
          currency: 'USD',
          cost: '10.5000',
          totalQty: 7,
          warehouses: [{ number: '1', qty: 7 }],
          raw: { line: 'test' },
        })
        .returning({ id: tdSynnexPriceAvailability.id })
    );
    expect(inserted[0]?.id).toBeDefined();

    const readBack = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: tdSynnexPriceAvailability.id, sku: tdSynnexPriceAvailability.synnexSku })
        .from(tdSynnexPriceAvailability)
        .where(eq(tdSynnexPriceAvailability.synnexSku, sku))
    );
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.sku).toBe(sku);
  });

  it('rejects a cross-partner INSERT into td_synnex_sftp_integrations with SQLSTATE 42501', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const cause = await captureRlsError(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(tdSynnexSftpIntegrations).values({
          partnerId: b.id, // forged: belongs to partner B
          region: 'US',
          accountNumber: `forge-${uniqueSuffix()}`.slice(0, 32),
          credentials: { password: 'enc:attacker' },
          enabled: true,
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "td_synnex_sftp_integrations"/
    );

    // ...and nothing landed: the victim partner has no row (checked as the
    // privileged role, which bypasses RLS, so this is a real absence).
    const adminRows = await (getTestDb() as any)
      .select({ id: tdSynnexSftpIntegrations.id })
      .from(tdSynnexSftpIntegrations)
      .where(eq(tdSynnexSftpIntegrations.partnerId, b.id));
    expect(adminRows).toEqual([]);
  });

  it('rejects a cross-partner INSERT into td_synnex_price_availability with SQLSTATE 42501', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const sku = `FORGE-${uniqueSuffix()}`.slice(0, 64);
    const cause = await captureRlsError(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(tdSynnexPriceAvailability).values({
          partnerId: b.id, // forged: belongs to partner B
          synnexSku: sku,
          cost: '1.0000',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "td_synnex_price_availability"/
    );

    const adminRows = await (getTestDb() as any)
      .select({ id: tdSynnexPriceAvailability.id })
      .from(tdSynnexPriceAvailability)
      .where(eq(tdSynnexPriceAvailability.partnerId, b.id));
    expect(adminRows).toEqual([]);
  });

  it('hides partner-B rows from a partner-A SELECT in both tables (seeded via system scope)', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const account = `b-${uniqueSuffix()}`.slice(0, 32);
    const sku = `B-SKU-${uniqueSuffix()}`.slice(0, 64);

    // System scope is exactly how the nightly ingest worker writes: it must be
    // able to create rows for ANY partner.
    const seeded = await withSystemDbAccessContext(async () => {
      const [cfg] = await db
        .insert(tdSynnexSftpIntegrations)
        .values({ partnerId: b.id, accountNumber: account, enabled: true })
        .returning({ id: tdSynnexSftpIntegrations.id });
      const [pa] = await db
        .insert(tdSynnexPriceAvailability)
        .values({ partnerId: b.id, synnexSku: sku, cost: '99.0000', totalQty: 3 })
        .returning({ id: tdSynnexPriceAvailability.id });
      return { cfg, pa };
    });
    expect(seeded.cfg?.id).toBeDefined(); // proves system scope CAN write for any partner
    expect(seeded.pa?.id).toBeDefined();

    const [cfgRows, paRows, cfgAll, paAll] = await withDbAccessContext(partnerAContext, async () => [
      await db
        .select({ id: tdSynnexSftpIntegrations.id })
        .from(tdSynnexSftpIntegrations)
        .where(eq(tdSynnexSftpIntegrations.partnerId, b.id)),
      await db
        .select({ id: tdSynnexPriceAvailability.id })
        .from(tdSynnexPriceAvailability)
        .where(eq(tdSynnexPriceAvailability.synnexSku, sku)),
      // Unfiltered reads: prove the rows are invisible even without a
      // partner_id predicate (the app layer isn't doing the filtering).
      await db.select({ id: tdSynnexSftpIntegrations.id }).from(tdSynnexSftpIntegrations),
      await db.select({ id: tdSynnexPriceAvailability.id }).from(tdSynnexPriceAvailability),
    ]);

    expect(cfgRows).toEqual([]);
    expect(paRows).toEqual([]);
    expect(cfgAll).toEqual([]);
    expect(paAll).toEqual([]);

    // Same rows ARE visible under system scope — proves the seed really landed
    // and the empty partner-A reads above are RLS, not an empty table.
    const systemRows = await withSystemDbAccessContext(() =>
      db
        .select({ id: tdSynnexPriceAvailability.id })
        .from(tdSynnexPriceAvailability)
        .where(eq(tdSynnexPriceAvailability.synnexSku, sku))
    );
    expect(systemRows).toHaveLength(1);
  });

  it('makes a cross-partner UPDATE/DELETE under partner scope a 0-row no-op (USING filters the target)', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const sku = `B-UPD-${uniqueSuffix()}`.slice(0, 64);
    await withSystemDbAccessContext(() =>
      db
        .insert(tdSynnexPriceAvailability)
        .values({ partnerId: b.id, synnexSku: sku, cost: '50.0000' })
    );

    const updated = await withDbAccessContext(partnerAContext, () =>
      db
        .update(tdSynnexPriceAvailability)
        .set({ cost: '0.0100' })
        .where(
          and(
            eq(tdSynnexPriceAvailability.partnerId, b.id),
            eq(tdSynnexPriceAvailability.synnexSku, sku)
          )
        )
        .returning({ id: tdSynnexPriceAvailability.id })
    );
    expect(updated).toEqual([]);

    const deleted = await withDbAccessContext(partnerAContext, () =>
      db
        .delete(tdSynnexPriceAvailability)
        .where(eq(tdSynnexPriceAvailability.synnexSku, sku))
        .returning({ id: tdSynnexPriceAvailability.id })
    );
    expect(deleted).toEqual([]);

    // The victim's row is untouched (verified with RLS bypassed).
    const [survivor] = await (getTestDb() as any)
      .select({ cost: tdSynnexPriceAvailability.cost })
      .from(tdSynnexPriceAvailability)
      .where(eq(tdSynnexPriceAvailability.synnexSku, sku));
    expect(survivor?.cost).toBe('50.0000');
  });
});

/**
 * The SECURITY DEFINER search function.
 *
 * `breeze_search_td_synnex_pa` runs as `breeze_search`, a role the tenant policy
 * does NOT apply to — deliberately, because Postgres refuses to use an index for
 * a non-leakproof qual (ILIKE) beneath an RLS security qual, which turns catalog
 * search into a full sequential scan. That means RLS is NOT protecting this path:
 * the function's own `partner_id = ANY(breeze_accessible_partner_ids())` predicate
 * is the ONLY thing standing between partner A and partner B's price list.
 *
 * So these are not "nice to have" tests — they are the isolation proof for the
 * one path in this feature where RLS has been deliberately stepped around. A
 * regression here leaks a competitor's negotiated distributor pricing.
 */
describe('breeze_search_td_synnex_pa — tenancy without RLS', () => {
  async function seedRow(partnerId: string, sku: string, name: string, qty = 5) {
    await withSystemDbAccessContext(() =>
      db.insert(tdSynnexPriceAvailability).values({
        partnerId, synnexSku: sku, name, mfgPartNo: `MPN-${sku}`,
        manufacturer: 'ACME', cost: '10.0000', totalQty: qty,
      })
    );
  }

  const search = (ctx: DbAccessContext, terms: string[], inStock = false) =>
    withDbAccessContext(ctx, () => {
      // ARRAY[$1, $2, ...] — passing the JS array as one param makes drizzle
      // expand it to a tuple, which fails the ::text[] cast (real-pg only bug).
      const list = terms.length
        ? sql`ARRAY[${sql.join(terms.map((t) => sql`${t}`), sql`, `)}]::text[]`
        : sql`ARRAY[]::text[]`;
      return db.execute<{ synnex_sku: string; partner_id: string }>(sql`
        SELECT * FROM public.breeze_search_td_synnex_pa(
          ${list}, ${inStock}::boolean, 50::int, 0::int)
      `);
    });

  it('returns the caller partner\'s own rows', async () => {
    const { a, partnerAContext } = await seedTwoPartners();
    const sku = `SKU-A-${uniqueSuffix()}`;
    await seedRow(a.id, sku, 'HP LaserJet Toner Cartridge');

    const rows = Array.from(await search(partnerAContext, ['toner']));
    expect(rows.map((r) => r.synnex_sku)).toContain(sku);
  });

  it('NEVER returns another partner\'s rows — the isolation proof for this path', async () => {
    const { a, b, partnerAContext } = await seedTwoPartners();
    const skuA = `SKU-A-${uniqueSuffix()}`;
    const skuB = `SKU-B-${uniqueSuffix()}`;
    // Both match the search term. Only A's may come back.
    await seedRow(a.id, skuA, 'HP LaserJet Toner Cartridge');
    await seedRow(b.id, skuB, 'HP LaserJet Toner Cartridge');

    const rows = Array.from(await search(partnerAContext, ['toner']));

    expect(rows.map((r) => r.synnex_sku)).toContain(skuA);
    expect(rows.map((r) => r.synnex_sku)).not.toContain(skuB);
    expect(rows.every((r) => r.partner_id === a.id)).toBe(true);
  });

  it('AND-s multiple terms rather than OR-ing them', async () => {
    const { a, partnerAContext } = await seedTwoPartners();
    const hit = `SKU-HIT-${uniqueSuffix()}`;
    const miss = `SKU-MISS-${uniqueSuffix()}`;
    await seedRow(a.id, hit, 'HP LaserJet Toner');
    await seedRow(a.id, miss, 'Dell Docking Station');

    const rows = Array.from(await search(partnerAContext, ['hp', 'toner']));
    const skus = rows.map((r) => r.synnex_sku);
    expect(skus).toContain(hit);
    expect(skus).not.toContain(miss); // an OR would have matched nothing/everything
  });

  it('escapes LIKE metacharacters — a bare "%" must not dump the catalog', async () => {
    const { a, partnerAContext } = await seedTwoPartners();
    await seedRow(a.id, `SKU-${uniqueSuffix()}`, 'HP LaserJet Toner');

    const rows = Array.from(await search(partnerAContext, ['%']));
    expect(rows).toHaveLength(0);
  });

  it('fails closed on empty terms rather than returning everything', async () => {
    const { a, partnerAContext } = await seedTwoPartners();
    await seedRow(a.id, `SKU-${uniqueSuffix()}`, 'HP LaserJet Toner');

    expect(Array.from(await search(partnerAContext, []))).toHaveLength(0);
    expect(Array.from(await search(partnerAContext, ['   ']))).toHaveLength(0);
  });

  it('honours the in-stock filter', async () => {
    const { a, partnerAContext } = await seedTwoPartners();
    const inStock = `SKU-IN-${uniqueSuffix()}`;
    const outOfStock = `SKU-OUT-${uniqueSuffix()}`;
    await seedRow(a.id, inStock, 'HP Toner Alpha', 7);
    await seedRow(a.id, outOfStock, 'HP Toner Beta', 0);

    const all = Array.from(await search(partnerAContext, ['toner'])).map((r) => r.synnex_sku);
    expect(all).toEqual(expect.arrayContaining([inStock, outOfStock]));

    const only = Array.from(await search(partnerAContext, ['toner'], true)).map((r) => r.synnex_sku);
    expect(only).toContain(inStock);
    expect(only).not.toContain(outOfStock);
  });

  it('actually uses the trigram GIN index (the entire reason the function exists)', async () => {
    const { a, partnerAContext } = await seedTwoPartners();
    await seedRow(a.id, `SKU-${uniqueSuffix()}`, 'HP LaserJet Toner');

    // Assert the index is USABLE, not that the planner picks it: on a table with
    // a handful of test rows a seq scan is correctly cheaper, so asserting the
    // chosen plan would fail for the wrong reason. enable_seqscan=off removes
    // that confound and leaves the real invariant — that ILIKE can be an INDEX
    // COND at all. If a future change puts an RLS security qual back on this
    // path, ILIKE is demoted to a Filter (non-leakproof quals cannot sit below a
    // security qual) and this fails. The prod symptom would otherwise be silent:
    // a full-catalog sequential scan on every keystroke.
    // SET LOCAL is transaction-scoped, so the SET and the EXPLAIN must run on the
    // SAME connection — issuing them as two pool calls silently lands them on
    // different backends and the SET is lost.
    const plan = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN (COSTS OFF)
        SELECT * FROM public.td_synnex_price_availability
        WHERE search_text ILIKE '%toner%'
      `);
    });
    const text = Array.from(plan).map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/td_synnex_pa_search_trgm_idx/);
    expect(text).toMatch(/Index Cond: \(search_text ~~\*/);
  });
});
