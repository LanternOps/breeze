import { describe, expect, it } from 'vitest';
import { BUSINESS_REPORT_TYPES } from '@breeze/shared';
import { INTERNAL_REPORT_TYPES, PARTNER_ONLY_DELIVERY_REPORT_TYPES } from '../../routes/reports/schemas';
import {
  carriedLastGeneratedAt,
  combineExclusionReason,
  combinePlanFingerprint,
  groupCombineRows,
  isScopeDenialRun,
  planGroupAdoption,
  resolveCombineCc,
  splitCombineCc,
  toCandidateGroup,
  type CombineSourceRow,
  type EligibleCombineRow,
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
    partnerId: null,
    // A complete v1 envelope (reportScheduleWorker completeExecutableScopePredicate).
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: '44444444-4444-4444-8444-444444444444',
    executionScopeFingerprint: 'f'.repeat(64),
    executionScopeCapturedAt: new Date('2026-09-01T00:00:00Z'),
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

  // W04 final review F1b: a row the worker never polls (it fails
  // completeExecutableScopePredicate) is not running today; adopting it would
  // capture a fresh scope and restart it. Every column rule of the predicate.
  it.each([
    ['legacy all-NULL envelope', {
      executionScopeVersion: null, executionScopeKind: null, executionScopeUserId: null,
      executionScopeFingerprint: null, executionScopeCapturedAt: null, executionScopePrincipalKind: null,
    }],
    ['version is not 1', { executionScopeVersion: 2 }],
    ['version is NULL', { executionScopeVersion: null }],
    ['unknown kind', { executionScopeKind: 'everything' }],
    ['no acting user', { executionScopeUserId: null }],
    ['no fingerprint', { executionScopeFingerprint: null }],
    ['no capture time', { executionScopeCapturedAt: null }],
    ['unrestricted with a site list', { executionScopeSiteIds: ['5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a'] }],
    ['partner_wide on an org-owned row (no partner_id)', { executionScopeKind: 'partner_wide' }],
  ] as const)('incomplete_execution_scope: %s', (_label, over) => {
    expect(combineExclusionReason(row(over as Partial<CombineSourceRow>))).toBe('incomplete_execution_scope');
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

// W04 final review F1a: the adopted row takes the newest run of its org's
// group rows, so it is not due for an occurrence a duplicate already sent.
describe('carriedLastGeneratedAt', () => {
  const at = (iso: string) => new Date(iso);
  it("is the newest lastGeneratedAt among the org's adopted row and its duplicates", () => {
    const adopt = row({ lastGeneratedAt: at('2026-01-01T08:00:00Z') });
    const dupNewest = row({ lastGeneratedAt: at('2026-09-28T08:00:05Z') });
    const dupOlder = row({ lastGeneratedAt: at('2026-09-21T08:00:05Z') });
    const dupNever = row({ lastGeneratedAt: null });
    const carried = carriedLastGeneratedAt({ adopt: adopt as EligibleCombineRow, archive: [dupOlder, dupNever, dupNewest] as EligibleCombineRow[] });
    expect(carried).toBe(dupNewest.lastGeneratedAt);
  });
  it("never lowers the adopted row's own value", () => {
    const adopt = row({ lastGeneratedAt: at('2026-09-28T08:00:05Z') });
    const dup = row({ lastGeneratedAt: at('2026-09-21T08:00:05Z') });
    expect(carriedLastGeneratedAt({ adopt: adopt as EligibleCombineRow, archive: [dup as EligibleCombineRow] }))
      .toBe(adopt.lastGeneratedAt);
  });
  it('carries a duplicate run onto a never-run adopted row, and stays null when nothing ever ran', () => {
    const dup = row({ lastGeneratedAt: at('2026-09-28T08:00:05Z') });
    expect(carriedLastGeneratedAt({ adopt: row() as EligibleCombineRow, archive: [dup as EligibleCombineRow] }))
      .toBe(dup.lastGeneratedAt);
    expect(carriedLastGeneratedAt({ adopt: row() as EligibleCombineRow, archive: [row() as EligibleCombineRow] })).toBeNull();
    expect(carriedLastGeneratedAt({ adopt: row() as EligibleCombineRow, archive: [] })).toBeNull();
  });
});

describe('isScopeDenialRun (the worker deny() shape)', () => {
  it("is a failed run whose error starts with 'scope_'", () => {
    expect(isScopeDenialRun({ status: 'failed', errorMessage: 'scope_membership_removed' })).toBe(true);
    expect(isScopeDenialRun({ status: 'failed', errorMessage: 'scope_legacy_unscoped' })).toBe(true);
    expect(isScopeDenialRun({ status: 'failed', errorMessage: 'boom' })).toBe(false);
    expect(isScopeDenialRun({ status: 'failed', errorMessage: 'series_skip_archived' })).toBe(false);
    expect(isScopeDenialRun({ status: 'failed', errorMessage: null })).toBe(false);
    expect(isScopeDenialRun({ status: 'completed', errorMessage: 'scope_membership_removed' })).toBe(false);
  });
});

// W04 final review F3: what the dialog showed, so the server can refuse a
// plan that changed between the GET and the POST (same key, same ids).
describe('combinePlanFingerprint', () => {
  const build = (rows: CombineSourceRow[], linked: string[] = []) => {
    const [group] = groupCombineRows(rows);
    const plan = planGroupAdoption(group!, new Set(linked));
    return combinePlanFingerprint(plan, splitCombineCc(plan));
  };
  const a1 = row({ orgId: 'org-a', lastGeneratedAt: new Date('2026-09-20T08:00:00Z'), config: { ...CONFIG, emailRecipients: ['cc@msp.test', 'extra@msp.test'] } });
  const a2 = row({ orgId: 'org-a', lastGeneratedAt: new Date('2026-09-01T08:00:00Z') });
  const b1 = row({ orgId: 'org-b', orgName: 'Bravo' });

  it('is sha256 hex and stable under input order', () => {
    const fp = build([a1, a2, b1]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(build([b1, a2, a1])).toBe(fp);
    expect(build([a2, b1, a1])).toBe(fp);
  });

  it('changes when a CC address changes (shared or conflicting)', () => {
    const fp = build([a1, a2, b1]);
    const b1WithExtra = { ...b1, config: { ...CONFIG, emailRecipients: ['cc@msp.test', 'new@msp.test'] } };
    expect(build([a1, a2, b1WithExtra])).not.toBe(fp);
    const a2NoCc = { ...a2, config: { ...CONFIG, emailRecipients: [] } };
    expect(build([a1, a2NoCc, b1])).not.toBe(fp);
  });

  it('changes when the adopted row changes, even with the same ids', () => {
    expect(build([a1, a2, b1], [a2.id])).not.toBe(build([a1, a2, b1]));
  });

  it('is the planFingerprint the candidate DTO carries', () => {
    const [group] = groupCombineRows([a1, a2, b1]);
    const plan = planGroupAdoption(group!, new Set());
    expect(toCandidateGroup(plan, new Map(), new Set(), new Set()).planFingerprint)
      .toBe(combinePlanFingerprint(plan, splitCombineCc(plan)));
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
      new Set([a1.id]),
    );
    expect(dto.orgs[0]!.rows[0]).toMatchObject({ reportId: a2.id, action: 'adopt', deliverableLinked: true, stalled: false });
    expect(dto.orgs[0]!.rows[1]).toMatchObject({ reportId: a1.id, action: 'archive', emailRecipients: ['cc@msp.test', 'extra@msp.test'], stalled: true });
    expect(dto.orgs[0]!.rows[0]!.contactRecipients).toEqual([{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }]);
    expect(dto.sharedCc).toEqual(['cc@msp.test']);
    expect(dto.groupKey).toBe(plan.groupKey);
  });
});
