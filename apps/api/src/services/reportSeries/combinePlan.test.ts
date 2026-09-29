import { describe, expect, it } from 'vitest';
import { BUSINESS_REPORT_TYPES } from '@breeze/shared';
import { INTERNAL_REPORT_TYPES, PARTNER_ONLY_DELIVERY_REPORT_TYPES } from '../../routes/reports/schemas';
import {
  combineExclusionReason,
  groupCombineRows,
  planGroupAdoption,
  resolveCombineCc,
  splitCombineCc,
  toCandidateGroup,
  type CombineSourceRow,
} from './combinePlan';

const SITE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const CONFIG = {
  dataSource: 'alerts',
  columns: ['severity', 'title'],
  schedule: { time: '08:00', day: 'monday' },
  emailRecipients: ['cc@msp.test'],
};

let seq = 0;
function row(over: Partial<CombineSourceRow> = {}): CombineSourceRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    orgId: 'org-a',
    orgName: 'Acme',
    name: 'Weekly alerts',
    type: 'alert_summary',
    format: 'pdf',
    schedule: 'weekly',
    config: CONFIG,
    lastGeneratedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    portalSelfService: false,
    sourceAiAgentScheduleId: null,
    executionScopeKind: 'unrestricted',
    executionScopePrincipalKind: 'user',
    seriesId: null,
    detachedFromSeriesId: null,
    archivedAt: null,
    ...over,
  };
}

describe('combineExclusionReason — spec §5 W04 exclusion list', () => {
  it.each([
    ['partner_owned', { orgId: null }],
    ['archived', { archivedAt: new Date() }],
    ['in_series', { seriesId: '11111111-1111-4111-8111-111111111111' }],
    // W04 ruling: a copy deliberately detached from a series is not re-combined.
    ['detached_from_series', { detachedFromSeriesId: '33333333-3333-4333-8333-333333333333' }],
    ['one_time', { schedule: 'one_time' as const }],
    ['portal_self_service', { portalSelfService: true }],
    // The managed evidence definition is portal_self_service by construction.
    ['portal_self_service', { type: 'threat_detection_review' as const, portalSelfService: true }],
    ['narrative', { sourceAiAgentScheduleId: '22222222-2222-4222-8222-222222222222' }],
    ['system_managed', { executionScopePrincipalKind: 'system' }],
    // Review Focus #2 — adoption would widen a site-limited report to every site.
    ['site_restricted_scope', { executionScopeKind: 'restricted' }],
    ['config_invalid', { config: { schedule: { time: 'nope' } } }],
  ] as const)('%s', (reason, over) => {
    expect(combineExclusionReason(row(over as Partial<CombineSourceRow>))).toBe(reason);
  });

  it('excludes every internal and partner-only-delivery (business) type', () => {
    const types = new Set<string>([...INTERNAL_REPORT_TYPES, ...PARTNER_ONLY_DELIVERY_REPORT_TYPES, ...BUSINESS_REPORT_TYPES]);
    for (const type of types) {
      expect(combineExclusionReason(row({ type: type as CombineSourceRow['type'], config: {} })), type).not.toBeNull();
    }
  });

  // Review Focus #3 — every way a builder config can name a site or device.
  it.each([
    ['filters.siteIds', { filters: { siteIds: [SITE] } }],
    ['filters.deviceIds', { filters: { deviceIds: [SITE] } }],
    ['sites', { sites: [SITE] }],
    ['legacyFilters.deviceIds', { legacyFilters: { deviceIds: [SITE] } }],
    ['filterConditions siteId', { filterConditions: [{ id: 'f1', logic: 'and', field: 'siteId', operator: 'is', value: SITE }] }],
  ])('config_org_specific: %s', (_label, extra) => {
    expect(combineExclusionReason(row({ config: { ...CONFIG, ...extra } }))).toBe('config_org_specific');
  });

  it('accepts an ordinary org-owned weekly report', () => {
    expect(combineExclusionReason(row())).toBeNull();
  });
});

describe('groupCombineRows', () => {
  it('groups across at least two orgs and ignores excluded rows when counting orgs', () => {
    const a = row({ orgId: 'org-a', orgName: 'Acme' });
    const b = row({ orgId: 'org-b', orgName: 'Bravo', config: { ...CONFIG, emailRecipients: ['CC@msp.test'] } });
    const bPortal = row({ orgId: 'org-c', orgName: 'Charlie', portalSelfService: true });
    const groups = groupCombineRows([a, b, bPortal]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((k) => k.row.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('never groups two duplicates inside ONE org', () => {
    expect(groupCombineRows([row({ orgId: 'org-a' }), row({ orgId: 'org-a' })])).toEqual([]);
  });
});

describe('planGroupAdoption', () => {
  it('adopts the deliverable-linked row, then newest run, then newest created, then smallest id', () => {
    const linked = row({ orgId: 'org-a', lastGeneratedAt: null });
    const newer = row({ orgId: 'org-a', lastGeneratedAt: new Date('2026-09-20T00:00:00Z') });
    const older = row({ orgId: 'org-a', lastGeneratedAt: new Date('2026-09-01T00:00:00Z') });
    const bNever = row({ orgId: 'org-b', orgName: 'Bravo', lastGeneratedAt: null, createdAt: new Date('2026-09-02T00:00:00Z') });
    const bNeverOlder = row({ orgId: 'org-b', orgName: 'Bravo', lastGeneratedAt: null, createdAt: new Date('2026-08-01T00:00:00Z') });
    const [group] = groupCombineRows([older, newer, linked, bNeverOlder, bNever]);
    const plan = planGroupAdoption(group!, new Set([linked.id]));
    const acme = plan.orgs.find((o) => o.orgId === 'org-a')!;
    expect(acme.adopt.id).toBe(linked.id);
    expect(acme.archive.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(plan.orgs.find((o) => o.orgId === 'org-b')!.adopt.id).toBe(bNever.id);

    const unlinked = planGroupAdoption(group!, new Set());
    expect(unlinked.orgs.find((o) => o.orgId === 'org-a')!.adopt.id).toBe(newer.id);
  });

  it('sorts orgs by name, takes the series config from the newest-updated adopted row, suggests the most common name', () => {
    // filterConditions ids are not part of the key but ARE kept in the stored
    // config, so they identify which row the series config was taken from.
    const fc = (id: string) => [{ id, logic: 'and', field: 'severity', operator: 'is', value: 'critical' }];
    const a = row({ orgId: 'org-a', orgName: 'Zulu', name: 'Weekly alerts', config: { ...CONFIG, filterConditions: fc('f-zulu') }, updatedAt: new Date('2026-09-10T00:00:00Z') });
    const b = row({ orgId: 'org-b', orgName: 'Alpha', name: 'Alerts', config: { ...CONFIG, filterConditions: fc('f-alpha') }, updatedAt: new Date('2026-09-11T00:00:00Z') });
    const c = row({ orgId: 'org-c', orgName: 'Mike', name: 'Weekly alerts', config: { ...CONFIG, filterConditions: fc('f-mike') } });
    const [group] = groupCombineRows([a, b, c]);
    const plan = planGroupAdoption(group!, new Set());
    expect(plan.orgs.map((o) => o.orgName)).toEqual(['Alpha', 'Mike', 'Zulu']);
    expect(plan.seriesConfig).toEqual({
      dataSource: 'alerts', columns: ['severity', 'title'], schedule: { time: '08:00', day: 'monday' }, filterConditions: fc('f-alpha'),
    });
    expect(plan.suggestedName).toBe('Weekly alerts');
  });
});

describe('CC split and resolution', () => {
  const a1 = row({ orgId: 'org-a', config: { ...CONFIG, emailRecipients: ['cc@msp.test', 'extra@msp.test'] } });
  const a2 = row({ orgId: 'org-a', config: { ...CONFIG, emailRecipients: ['cc@msp.test'] } });
  const b1 = row({ orgId: 'org-b', orgName: 'Bravo', config: { ...CONFIG, emailRecipients: ['CC@MSP.test'] } });
  const [group] = groupCombineRows([a1, a2, b1]);

  it('treats case as the same address; lists the rest with their reports', () => {
    expect(splitCombineCc(group!)).toEqual({
      shared: ['cc@msp.test'],
      conflicting: [{ email: 'extra@msp.test', reportIds: [a1.id] }],
    });
  });

  it('refuses an unresolved, unknown or doubly-resolved address', () => {
    const split = splitCombineCc(group!);
    expect(resolveCombineCc(split, { include: [], drop: [] })).toEqual({
      ok: false, shared: ['cc@msp.test'], unresolved: [{ email: 'extra@msp.test', reportIds: [a1.id] }], unexpected: [],
    });
    expect(resolveCombineCc(split, { include: ['extra@msp.test', 'typo@msp.test'], drop: [] }))
      .toMatchObject({ ok: false, unexpected: ['typo@msp.test'] });
    expect(resolveCombineCc(split, { include: ['extra@msp.test'], drop: ['EXTRA@msp.test'] }))
      .toMatchObject({ ok: false, unexpected: ['extra@msp.test'] });
  });

  it('include adds to the internal CC; drop removes it', () => {
    const split = splitCombineCc(group!);
    expect(resolveCombineCc(split, { include: [' Extra@MSP.test'], drop: [] }))
      .toEqual({ ok: true, internalCc: ['cc@msp.test', 'extra@msp.test'], addedCc: ['extra@msp.test'] });
    expect(resolveCombineCc(split, { include: [], drop: ['extra@msp.test'] }))
      .toEqual({ ok: true, internalCc: ['cc@msp.test'], addedCc: [] });
  });

  it('shapes the candidate DTO the dialog renders', () => {
    const plan = planGroupAdoption(group!, new Set([a2.id]));
    const dto = toCandidateGroup(
      plan,
      new Map([[a2.id, [{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }]]]),
      new Set([a2.id]),
    );
    expect(dto.orgs[0]!.rows[0]).toMatchObject({ reportId: a2.id, action: 'adopt', deliverableLinked: true });
    expect(dto.orgs[0]!.rows[1]).toMatchObject({ reportId: a1.id, action: 'archive', emailRecipients: ['cc@msp.test', 'extra@msp.test'] });
    expect(dto.orgs[0]!.rows[0]!.contactRecipients).toEqual([{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }]);
    expect(dto.sharedCc).toEqual(['cc@msp.test']);
    expect(dto.groupKey).toBe(plan.groupKey);
  });
});
