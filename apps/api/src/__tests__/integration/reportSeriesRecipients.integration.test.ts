/**
 * Multi-org report series W02 — target eligibility, recipient resolution and
 * detach materialization against real Postgres (spec §3.3, §3.5; plan Review
 * Focus 2).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reportSeries } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { resolveSeriesTargetOrgIds } from '../../services/reportSeries/targets';
import {
  materializeDetachedRecipients,
  resolveSeriesChildRecipients,
} from '../../services/reportSeries/recipients';

const system = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function contact(orgId: string, email: string, opts: { primary?: boolean; siteLevel?: boolean; roles?: string[] } = {}) {
  const id = randomUUID();
  let siteId: string | null = null;
  if (opts.siteLevel) {
    siteId = randomUUID();
    await db.execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${siteId}, ${orgId}, ${`site-${siteId.slice(0, 6)}`})`);
  }
  await db.execute(sql`
    INSERT INTO contacts (id, org_id, site_id, name, email, is_primary, roles)
    VALUES (${id}, ${orgId}, ${siteId}, ${email}, ${email}, ${opts.primary ?? false},
            ${`{${(opts.roles ?? []).join(',')}}`}::text[])`);
  return id;
}

async function childReport(orgId: string, seriesId: string) {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision)
    VALUES (${id}, ${orgId}, 'Monthly', 'executive_summary', 'monthly', ${seriesId}, 1)`);
  return id;
}

async function override(reportId: string, orgId: string, contactId: string, mode: 'add' | 'remove') {
  await db.execute(sql`
    INSERT INTO report_schedule_recipients (report_id, org_id, contact_id, mode)
    VALUES (${reportId}, ${orgId}, ${contactId}, ${mode})`);
}

describe('resolveSeriesTargetOrgIds', () => {
  it('counts only active/trial, non-deleted orgs of the series partner, per target mode', async () => {
    await system(async () => {
      const partner = await createPartner();
      const other = await createPartner();
      const active = await createOrganization({ partnerId: partner.id });
      const trial = await createOrganization({ partnerId: partner.id, status: 'trial' });
      const suspended = await createOrganization({ partnerId: partner.id, status: 'suspended' });
      const deleted = await createOrganization({ partnerId: partner.id, deletedAt: new Date() });
      const excluded = await createOrganization({ partnerId: partner.id });
      await createOrganization({ partnerId: other.id });

      const [all] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'All', type: 'executive_summary', schedule: 'monthly', targetMode: 'all',
      }).returning();
      await db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${all!.id}, ${excluded.id})`);
      expect(await resolveSeriesTargetOrgIds(all!, db)).toEqual([active.id, trial.id].sort());

      const [chosen] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'Chosen', type: 'executive_summary', schedule: 'monthly', targetMode: 'selected',
      }).returning();
      await db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id)
                           VALUES (${chosen!.id}, ${suspended.id}), (${chosen!.id}, ${trial.id})`);
      expect(await resolveSeriesTargetOrgIds(chosen!, db)).toEqual([trial.id]);
      expect(deleted.id).toBeDefined();
    });
  });
});

describe('resolveSeriesChildRecipients', () => {
  it('rule (org-level primary + roles) ∪ adds − removes; site-level primaries never match', async () => {
    await system(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const [series] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'S', type: 'executive_summary', schedule: 'monthly',
      }).returning();
      const report = await childReport(org.id, series!.id);
      await contact(org.id, 'primary@acme.test', { primary: true });
      await contact(org.id, 'site-primary@acme.test', { primary: true, siteLevel: true });
      const billing = await contact(org.id, 'billing@acme.test', { roles: ['billing'] });
      const extra = await contact(org.id, 'extra@acme.test');

      await override(report, org.id, extra, 'add');
      await override(report, org.id, billing, 'remove');

      const out = await resolveSeriesChildRecipients({
        reportId: report,
        orgId: org.id,
        rule: { primaryContact: true, roles: ['billing'] },
        internalCc: ['noc@msp.test'],
      });
      expect([...out.customer].sort()).toEqual(['extra@acme.test', 'primary@acme.test']);
      expect(out.cc).toEqual(['noc@msp.test']);
    });
  });
});

// Review Focus 2.
describe('materializeDetachedRecipients', () => {
  it('turns current rule matches into add rows, keeps explicit adds, and drops remove rows', async () => {
    await system(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const [series] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'S', type: 'executive_summary', schedule: 'monthly',
      }).returning();
      const report = await childReport(org.id, series!.id);
      const primary = await contact(org.id, 'primary@acme.test', { primary: true });
      const removedMatch = await contact(org.id, 'ops@acme.test', { roles: ['technical'] });
      const explicit = await contact(org.id, 'extra@acme.test');
      await override(report, org.id, explicit, 'add');
      await override(report, org.id, removedMatch, 'remove');

      const result = await materializeDetachedRecipients(db, {
        reportId: report,
        orgId: org.id,
        rule: { primaryContact: true, roles: ['technical'] },
      });
      expect(result).toEqual({ added: 1, removedDropped: 1 });

      const rows = (await db.execute(sql`
        SELECT contact_id, mode FROM report_schedule_recipients WHERE report_id = ${report} ORDER BY contact_id`,
      )) as unknown as Array<{ contact_id: string; mode: string }>;
      expect(rows.map((r) => r.mode)).toEqual(['add', 'add']);
      expect(rows.map((r) => r.contact_id).sort()).toEqual([primary, explicit].sort());
    });
  });
});
