/**
 * Multi-org report series W02 — org merge (spec §5 W02 "Org merge
 * integration"). Two orgs with active children of the same series merge
 * without 23505 or 23503; the survivor keeps its child; the loser's child is
 * archived with its runs attached; overrides are unioned with removes
 * winning; target rows dedupe with the row surviving. Rolled back.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { CUSTOM_EXECUTORS } from '../../services/orgMergeCustomExecutors';
import { buildRepoint, buildRepointDedupe } from '../../services/orgMergeExecutors';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { reconcileSeries, seriesChildGate } from '../../services/reportSeries/reconcile';

class Rollback extends Error {}

describe('org merge — multi-org report series children', () => {
  it('archives the colliding loser child, keeps its runs, unions overrides (removes win), dedupes targets', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const series = randomUUID();
    const childL = randomUUID();
    const childS = randomUUID();
    const runL = randomUUID();
    const shared = randomUUID();
    const loserOnly = randomUUID();
    const removedByLoser = randomUUID();

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Series merge', ${`series-merge-${P.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`sm-l-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`sm-s-${S.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO report_series (id, partner_id, name, type, schedule, target_mode)
          VALUES (${series}::uuid, ${P}::uuid, 'Monthly', 'executive_summary', 'monthly', 'all')`);
        // Both orgs excluded -> the dedupe keeps exactly one exclusion row.
        await db.execute(sql`
          INSERT INTO report_series_org_targets (series_id, org_id)
          VALUES (${series}::uuid, ${L}::uuid), (${series}::uuid, ${S}::uuid)`);
        await db.execute(sql`
          INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision) VALUES
            (${childL}::uuid, ${L}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1),
            (${childS}::uuid, ${S}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1)`);
        await db.execute(sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runL}::uuid, ${childL}::uuid, 'completed')`);
        await db.execute(sql`
          INSERT INTO contacts (id, org_id, name, email) VALUES
            (${shared}::uuid, ${L}::uuid, 'Shared', ${`shared-${P}@example.com`}),
            (${loserOnly}::uuid, ${L}::uuid, 'Loser only', ${`only-${P}@example.com`}),
            (${removedByLoser}::uuid, ${L}::uuid, 'Removed', ${`removed-${P}@example.com`})`);

        // Mid-merge state (contacts already repointed), as in the portal-report case.
        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        await db.execute(sql`
          INSERT INTO report_schedule_recipients (report_id, org_id, contact_id, mode) VALUES
            (${childL}::uuid, ${L}::uuid, ${shared}::uuid, 'add'),
            (${childS}::uuid, ${S}::uuid, ${shared}::uuid, 'add'),
            (${childL}::uuid, ${L}::uuid, ${loserOnly}::uuid, 'add'),
            (${childL}::uuid, ${L}::uuid, ${removedByLoser}::uuid, 'remove'),
            (${childS}::uuid, ${S}::uuid, ${removedByLoser}::uuid, 'add')`);
        await db.execute(sql`UPDATE contacts SET org_id = ${S}::uuid WHERE org_id = ${L}::uuid`);

        const out = await CUSTOM_EXECUTORS.reports!(L, S);
        expect(out.dropped).toBe(0);
        expect(out.notes.join('\n')).toMatch(/archived 1 multi-org report child/);

        const targetsPolicy = getOrgMergePolicies().get('report_series_org_targets');
        expect(targetsPolicy).toEqual({ kind: 'repoint-dedupe', key: ['series_id'] });
        // buildRepointDedupe returns [dedupe DELETE, repoint UPDATE] (orgMergeExecutors.ts:51).
        for (const statement of buildRepointDedupe('report_series_org_targets', ['series_id'], undefined, L, S)) {
          await db.execute(statement);
        }
        await db.execute(buildRepoint('report_schedule_recipients', L, S));
        // #4247: the archived child's runs keep its id, and their org_id follows
        // the child's repointed org_id (report_runs is a plain registry repoint).
        expect(getOrgMergePolicies().get('report_runs')).toEqual({ kind: 'repoint' });
        await db.execute(buildRepoint('report_runs', L, S));
        await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);

        const children = (await db.execute(sql`
          SELECT id, org_id, archived_at IS NOT NULL AS archived FROM reports
           WHERE series_id = ${series}::uuid ORDER BY archived`)) as unknown as Array<{ id: string; org_id: string; archived: boolean }>;
        expect(children).toEqual([
          { id: childS, org_id: S, archived: false },
          { id: childL, org_id: S, archived: true },
        ]);

        const runs = (await db.execute(sql`SELECT report_id FROM report_runs WHERE id = ${runL}::uuid`)) as unknown as Array<{ report_id: string }>;
        expect(runs).toEqual([{ report_id: childL }]);

        const overrides = (await db.execute(sql`
          SELECT contact_id, mode, org_id FROM report_schedule_recipients
           WHERE report_id = ${childS}::uuid ORDER BY contact_id`)) as unknown as Array<{ contact_id: string; mode: string; org_id: string }>;
        const byContact = new Map(overrides.map((row) => [row.contact_id, row.mode]));
        expect(byContact.get(shared)).toBe('add');
        expect(byContact.get(loserOnly)).toBe('add');
        expect(byContact.get(removedByLoser)).toBe('remove');
        expect(overrides.every((row) => row.org_id === S)).toBe(true);

        const targets = (await db.execute(sql`
          SELECT org_id FROM report_series_org_targets WHERE series_id = ${series}::uuid`)) as unknown as Array<{ org_id: string }>;
        expect(targets).toEqual([{ org_id: S }]);

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }, 120_000);

  it('a loser child with no survivor twin is simply repointed, still active', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const series = randomUUID();
    const childL = randomUUID();
    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Series merge 2', ${`series-merge2-${P.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`sm2-l-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`sm2-s-${S.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO report_series (id, partner_id, name, type, schedule)
          VALUES (${series}::uuid, ${P}::uuid, 'Monthly', 'executive_summary', 'monthly')`);
        await db.execute(sql`
          INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision)
          VALUES (${childL}::uuid, ${L}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1)`);
        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const out = await CUSTOM_EXECUTORS.reports!(L, S);
        expect(out.moved).toBe(1);
        await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const rows = (await db.execute(sql`
          SELECT org_id, archived_at FROM reports WHERE id = ${childL}::uuid`)) as unknown as Array<{ org_id: string; archived_at: Date | null }>;
        expect(rows).toEqual([{ org_id: S, archived_at: null }]);
        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }, 120_000);

  // Final review #1: a detached standalone survives the merge (repointed into
  // the survivor, still remembering its series), which un-targets the survivor
  // for that series. The survivor's own child is therefore skipped by the
  // worker gate at once and archived by the next reconcile, so the customer
  // keeps exactly one copy: the standalone they chose to detach.
  it('a loser detached standalone repoints to the survivor and wins over the survivor child', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const series = randomUUID();
    const standaloneL = randomUUID();
    const childS = randomUUID();
    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Series merge 3', ${`series-merge3-${P.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`sm3-l-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`sm3-s-${S.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO report_series (id, partner_id, name, type, schedule, target_mode)
          VALUES (${series}::uuid, ${P}::uuid, 'Monthly', 'executive_summary', 'monthly', 'selected')`);
        await db.execute(sql`
          INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}::uuid, ${S}::uuid)`);
        await db.execute(sql`
          INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision, detached_from_series_id) VALUES
            (${standaloneL}::uuid, ${L}::uuid, 'Monthly', 'executive_summary', 'monthly', NULL, NULL, ${series}::uuid),
            (${childS}::uuid, ${S}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1, NULL)`);

        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const out = await CUSTOM_EXECUTORS.reports!(L, S);
        expect(out.moved).toBe(1);
        await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const moved = (await db.execute(sql`
          SELECT org_id, series_id, detached_from_series_id, archived_at FROM reports WHERE id = ${standaloneL}::uuid`)) as unknown as Array<Record<string, unknown>>;
        expect(moved).toEqual([{ org_id: S, series_id: null, detached_from_series_id: series, archived_at: null }]);

        // Right after the merge the survivor child is no longer targeted: a queued job for it is skipped.
        expect(await seriesChildGate({ id: childS, orgId: S, seriesId: series, seriesRevision: 1, archivedAt: null }))
          .toBe('skip_untargeted');
        const result = await reconcileSeries(series, db);
        expect(result).toMatchObject({ created: 0, archived: 1 });
        const active = (await db.execute(sql`
          SELECT id FROM reports
           WHERE org_id = ${S}::uuid AND archived_at IS NULL
             AND (series_id = ${series}::uuid OR detached_from_series_id = ${series}::uuid)`)) as unknown as Array<{ id: string }>;
        expect(active).toEqual([{ id: standaloneL }]);
        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }, 120_000);
});
