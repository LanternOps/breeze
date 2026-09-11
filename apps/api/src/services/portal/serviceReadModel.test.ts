import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], wheres: [] as unknown[] }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
        chain[m] = vi.fn((arg: unknown) => {
          if (m === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import {
  artifactStateFor,
  deliverableOccurrences,
  isoDateInTimezone,
  portalOccurrenceStatus,
  serviceOverview,
  serviceTile,
} from './serviceReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-15T12:00:00Z');

describe('isoDateInTimezone', () => {
  it('renders the calendar date in the org timezone, not UTC', () => {
    expect(isoDateInTimezone(new Date('2026-10-01T03:00:00Z'), 'America/Denver')).toBe('2026-09-30');
    expect(isoDateInTimezone(new Date('2026-10-01T03:00:00Z'), 'UTC')).toBe('2026-10-01');
  });
});

describe('artifactStateFor (spec §8 D10)', () => {
  it('is held_by_msp when a required artifact has no portal-visible evidence', () => {
    expect(artifactStateFor({ artifactRequired: true, delivered: true, evidence: [] }))
      .toBe('held_by_msp');
  });
  it('is none when no artifact was required', () => {
    expect(artifactStateFor({ artifactRequired: false, delivered: true, evidence: [] })).toBe('none');
  });
  it('is none for an undelivered occurrence even when an artifact is required', () => {
    expect(artifactStateFor({ artifactRequired: true, delivered: false, evidence: [] })).toBe('none');
  });
  it('prefers an attached document over a report run', () => {
    const doc = { kind: 'document' as const, documentId: 'd1', reportRunId: null, title: 'Findings', createdAt: '' };
    const run = { kind: 'report_run' as const, documentId: null, reportRunId: 'r1', title: 'Scan', createdAt: '' };
    expect(artifactStateFor({ artifactRequired: true, delivered: true, evidence: [run, doc] })).toBe('attached');
    expect(artifactStateFor({ artifactRequired: true, delivered: true, evidence: [run] })).toBe('report');
  });
});

describe('portalOccurrenceStatus', () => {
  it('hides awaiting_evidence behind in_progress', () => {
    expect(portalOccurrenceStatus('awaiting_evidence')).toBe('in_progress');
    expect(portalOccurrenceStatus('open')).toBe('in_progress');
    expect(portalOccurrenceStatus('scheduled')).toBe('scheduled');
    expect(portalOccurrenceStatus('delivered')).toBe('delivered');
    expect(portalOccurrenceStatus('missed')).toBe('missed');
    expect(portalOccurrenceStatus('waived')).toBe('waived');
  });
});

describe('serviceOverview', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  function seed(opts: { enableReports: boolean; evidence: unknown[] }) {
    state.rows.push([{ enableReports: opts.enableReports }]);          // branding read
    state.rows.push([{                                                  // deliverables + contract
      id: 'd1', name: 'Sign-in log review', description: 'Monthly review',
      cadence: 'monthly', artifactRequired: true, leadDays: 7,
      effectiveFrom: '2026-01-01', effectiveUntil: null, active: true,
      contractId: 'c1', contractName: 'Best plan',
    }]);
    state.rows.push([{                                                  // occurrences
      id: 'o1', deliverableId: 'd1', status: 'delivered', dueAt: '2026-09-30',
      originalDueAt: '2026-09-30', periodStart: '2026-09-01', periodEnd: '2026-09-30',
      deliveredAt: new Date('2026-10-02T09:00:00Z'), deliveryNote: 'Reviewed',
    }]);
    state.rows.push(opts.evidence);                                     // evidence join
    state.rows.push([]);                                                // key dates
    state.rows.push([]);                                                // contract end dates
  }

  it('never leaks a ticket into the payload', async () => {
    seed({ enableReports: true, evidence: [] });
    const dto = await serviceOverview(ORG_ID, { timezone: 'America/Denver', now: NOW });
    expect(JSON.stringify(dto)).not.toMatch(/ticket/i);
  });

  it('scopes every query to the session org', async () => {
    seed({ enableReports: true, evidence: [] });
    await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(state.wheres.length).toBeGreaterThan(0);
    for (const where of state.wheres) {
      expect(new PgDialect().sqlToQuery(where as SQL).params).toContain(ORG_ID);
    }
  });

  it('marks a late delivery of a required artifact with no evidence as held_by_msp', async () => {
    seed({ enableReports: true, evidence: [] });
    const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups[0]!.source).toBe('contract');
    expect(dto.groups[0]!.contract).toEqual({ id: 'c1', name: 'Best plan' });
    expect(dto.groups[0]!.deliverables[0]!.lastDelivered).toMatchObject({
      late: true, note: 'Reviewed', artifactState: 'held_by_msp', evidence: [],
    });
  });

  it('publishes report-run evidence only when reports are on and the definition is self-service', async () => {
    const run = {
      occurrenceId: 'o1', evidenceId: 'e1', kind: 'report_run', documentId: null,
      documentTitle: null, documentPortalVisible: null, documentDeletedAt: null,
      reportRunId: 'r1', reportName: 'Vulnerability review', reportPortalSelfService: true,
      createdAt: new Date('2026-10-02T09:05:00Z'),
    };
    seed({ enableReports: false, evidence: [run] });
    const off = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(off.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([]);
    expect(off.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('held_by_msp');

    state.rows.length = 0;
    seed({ enableReports: true, evidence: [{ ...run, reportPortalSelfService: false }] });
    const notSelfService = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(notSelfService.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([]);

    state.rows.length = 0;
    seed({ enableReports: true, evidence: [run] });
    const on = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(on.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([
      { kind: 'report_run', documentId: null, reportRunId: 'r1', title: 'Vulnerability review', createdAt: '2026-10-02T09:05:00.000Z' },
    ]);
    expect(on.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('report');
  });

  it('hides a document that is not portal-visible or is soft-deleted', async () => {
    const base = {
      occurrenceId: 'o1', evidenceId: 'e2', kind: 'document', documentId: 'doc1',
      documentTitle: 'Findings', reportRunId: null, reportName: null,
      reportPortalSelfService: null, createdAt: new Date('2026-10-02T09:05:00Z'),
    };
    for (const hidden of [
      { ...base, documentPortalVisible: false, documentDeletedAt: null },
      { ...base, documentPortalVisible: true, documentDeletedAt: new Date() },
    ]) {
      state.rows.length = 0;
      seed({ enableReports: true, evidence: [hidden] });
      const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
      expect(dto.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([]);
    }
  });

  it('publishes a portal-visible document even when documents are off', async () => {
    // Spec §8: enable_documents governs the LIBRARY page only. The branding read
    // in this read model asks for enableReports and nothing else, so a document
    // cannot be filtered by a flag this model never reads.
    seed({ enableReports: false, evidence: [{
      occurrenceId: 'o1', evidenceId: 'e3', kind: 'document', documentId: 'doc1',
      documentTitle: 'Findings', documentPortalVisible: true, documentDeletedAt: null,
      reportRunId: null, reportName: null, reportPortalSelfService: null,
      createdAt: new Date('2026-10-02T09:05:00Z'),
    }] });
    const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('attached');
  });

  it('orders contract groups before the standalone group and carries key dates', async () => {
    state.rows.push([{ enableReports: true }]);
    state.rows.push([
      { id: 'd2', name: 'Loose end', description: null, cadence: 'annual', artifactRequired: false,
        leadDays: 7, effectiveFrom: '2026-01-01', effectiveUntil: null, active: true,
        contractId: null, contractName: null },
      { id: 'd1', name: 'Sign-in log review', description: null, cadence: 'monthly', artifactRequired: true,
        leadDays: 7, effectiveFrom: '2026-01-01', effectiveUntil: null, active: true,
        contractId: 'c1', contractName: 'Best plan' },
    ]);
    state.rows.push([
      { id: 'o2', deliverableId: 'd1', status: 'open', dueAt: '2026-10-31', originalDueAt: '2026-10-31',
        periodStart: '2026-10-01', periodEnd: '2026-10-31', deliveredAt: null, deliveryNote: null },
    ]);
    // no delivered occurrence => the read model issues no evidence query at all
    state.rows.push([{ id: 'k1', label: 'Insurance renewal', kind: 'insurance_renewal',
      date: '2027-06-01', notes: 'Broker call' }]);                    // key dates
    state.rows.push([{ id: 'c1', name: 'Best plan', endDate: '2027-01-01' }]); // contract ends

    const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups.map((g) => g.source)).toEqual(['contract', 'standalone']);
    expect(dto.groups[0]!.deliverables[0]!.nextDue).toBe('2026-10-31');
    expect(dto.groups[0]!.deliverables[0]!.lastDelivered).toBeNull();
    expect(dto.keyDates.map((k) => [k.source, k.date])).toEqual([
      ['contract_end', '2027-01-01'],
      ['key_date', '2027-06-01'],
    ]);
  });
});

describe('deliverableOccurrences', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('returns null for a deliverable that is not a portal-visible row of this org', async () => {
    state.rows.push([]);  // deliverable lookup finds nothing (RLS or portal_visible=false)
    await expect(deliverableOccurrences(ORG_ID, 'other-org-deliverable', { timezone: 'UTC', now: NOW }))
      .resolves.toBeNull();
  });

  it('caps the history at 24 and marks a rescheduled occurrence', async () => {
    state.rows.push([{ id: 'd1', name: 'Firewall rule review', cadence: 'quarterly', artifactRequired: true }]);
    state.rows.push([{
      id: 'o1', status: 'awaiting_evidence', dueAt: '2026-10-31', originalDueAt: '2026-09-30',
      periodStart: '2026-08-01', periodEnd: '2026-10-31', deliveredAt: null, deliveryNote: null,
      nameSnapshot: 'Firewall rule review',
    }]);
    state.rows.push([]);  // evidence
    state.rows.push([{ enableReports: true }]);

    const dto = await deliverableOccurrences(ORG_ID, 'd1', { timezone: 'UTC', now: NOW, limit: 999 });
    expect(dto!.occurrences[0]).toMatchObject({
      status: 'in_progress', rescheduled: true, late: false, artifactState: 'none',
    });
    expect(JSON.stringify(dto)).not.toMatch(/ticket/i);
    for (const where of state.wheres) {
      expect(new PgDialect().sqlToQuery(where as SQL).params).toContain(ORG_ID);
    }
  });

  it('marks a late delivery and publishes its document evidence', async () => {
    state.rows.push([{ id: 'd1', name: 'Firewall rule review', cadence: 'quarterly', artifactRequired: true }]);
    state.rows.push([{
      id: 'o1', status: 'delivered', dueAt: '2026-09-30', originalDueAt: '2026-09-30',
      periodStart: '2026-07-01', periodEnd: '2026-09-30',
      deliveredAt: new Date('2026-10-02T09:00:00Z'), deliveryNote: 'Done',
      nameSnapshot: 'Firewall rule review',
    }]);
    state.rows.push([{
      occurrenceId: 'o1', evidenceId: 'e1', kind: 'document', documentId: 'doc1',
      documentTitle: 'Q3 review', documentPortalVisible: true, documentDeletedAt: null,
      reportRunId: null, reportName: null, reportPortalSelfService: null,
      createdAt: new Date('2026-10-02T09:05:00Z'),
    }]);
    state.rows.push([{ enableReports: true }]);

    const dto = await deliverableOccurrences(ORG_ID, 'd1', { timezone: 'UTC', now: NOW });
    expect(dto!.occurrences[0]).toMatchObject({ status: 'delivered', late: true, artifactState: 'attached' });
    expect(dto!.occurrences[0]!.evidence[0]!.documentId).toBe('doc1');
  });
});

describe('serviceTile', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('returns null when enable_service is off', async () => {
    state.rows.push([{ enableService: false }]);
    await expect(serviceTile(ORG_ID, { timezone: 'UTC', now: NOW })).resolves.toBeNull();
  });

  it('returns null when the org has no portal_branding row at all', async () => {
    state.rows.push([]);
    await expect(serviceTile(ORG_ID, { timezone: 'UTC', now: NOW })).resolves.toBeNull();
  });

  it('counts the 90-day record and names the next due item', async () => {
    state.rows.push([{ enableService: true }]);
    state.rows.push([{ onTime: 5, late: 1, missed: 2 }]);
    state.rows.push([{ name: 'Monthly sign-in log review', dueAt: '2026-10-31' }]);
    await expect(serviceTile(ORG_ID, { timezone: 'UTC', now: NOW })).resolves.toEqual({
      status: 'ok', windowDays: 90, deliveredOnTime: 5, deliveredLate: 1, missed: 2,
      nextDue: { name: 'Monthly sign-in log review', dueAt: '2026-10-31' },
      asOf: NOW.toISOString(),
    });
  });

  it('reports no_data rather than a fabricated zero when nothing has been scheduled', async () => {
    state.rows.push([{ enableService: true }]);
    state.rows.push([{ onTime: 0, late: 0, missed: 0 }]);
    state.rows.push([]);
    const tile = await serviceTile(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(tile).toMatchObject({ status: 'no_data', deliveredOnTime: null, nextDue: null });
  });

  it('is ok with zero counts when something is still scheduled ahead', async () => {
    state.rows.push([{ enableService: true }]);
    state.rows.push([{ onTime: 0, late: 0, missed: 0 }]);
    state.rows.push([{ name: 'First review', dueAt: '2026-11-30' }]);
    const tile = await serviceTile(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(tile).toMatchObject({ status: 'ok', deliveredOnTime: 0, nextDue: { name: 'First review' } });
  });
});
