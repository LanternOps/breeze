import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drizzle mock pattern per the breeze-testing skill: every `db.select()` call
// resolves the next queued row set, in call order (copied from
// hardwareLifecycleReport.test.ts).
vi.mock('../db', () => ({ db: { select: vi.fn() } }));

const { freshnessMock } = vi.hoisted(() => ({ freshnessMock: vi.fn() }));
vi.mock('./m365Sync/summary', () => ({ loadDomainFreshness: freshnessMock }));
vi.mock('../config/env', () => ({ isM365TenantSyncEnabled: () => true }));

import type {
  EndpointManagementSummary,
  IntuneDeviceRow,
} from '@breeze/shared';
import { db } from '../db';
import { generateEndpointManagementReport } from './endpointManagementReport';
import type { ReportResult } from './reportGenerationService';
import type { OrgReportExecutionAuthority } from './siteScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PERIOD_SEP = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  generatedAt: '2026-09-30T06:00:00.000Z',
  deliverableId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

function queueSelects(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.select).mockImplementation((() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'where', 'limit']) {
      chain[method] = () => chain;
    }
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

function authority(
  kind: 'unrestricted' | 'restricted' = 'unrestricted',
  siteIds: string[] = [],
): OrgReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG, siteIds }
      : { version: 1, kind, orgId: ORG },
    principalUserId: USER,
    capturedAt: new Date('2026-09-30T06:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

const AUTH_UNRESTRICTED = authority('unrestricted');
const AUTH_RESTRICTED_S1 = authority('restricted', [SITE_A]);
const AUTH_RESTRICTED_ZERO = authority('restricted', []);

const ORG_ROW = [{ id: ORG, name: 'Acme Legal' }];

const MEASURED = {
  asOf: '2026-09-30T04:00:00.000Z',
  lastStatus: 'success',
  truncated: false,
  sources: { managedDevices: 'ok' },
  unlicensed: false,
};
const NEVER_RAN = { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false };

function freshness(overrides: Record<string, unknown> = {}) {
  freshnessMock.mockResolvedValue({ intune_devices: MEASURED, skus: MEASURED, ...overrides });
}

function intuneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    deviceName: 'LT-001',
    operatingSystem: 'Windows',
    osVersion: '10.0.22631',
    userPrincipalName: 'a@acme.test',
    ownerType: 'company',
    lastIntuneSyncAt: new Date('2026-09-30T03:00:00.000Z'),
    complianceState: 'compliant',
    jailBroken: 'Unknown',
    isStale: false,
    breezeDeviceId: 'd0000000-0000-4000-8000-000000000001',
    ...overrides,
  };
}

function summaryOf(result: ReportResult): EndpointManagementSummary {
  return result.summary as EndpointManagementSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  freshness();
  queueSelects(ORG_ROW);
});

describe('generateEndpointManagementReport', () => {
  it('renders a data-gap page when the intune_devices domain has never completed a snapshot', async () => {
    freshness({ intune_devices: NEVER_RAN });
    queueSelects(ORG_ROW, []);

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED));
    expect(s.enrolment?.intuneDevices).toBeNull(); // unmeasured, NOT zero
    expect(s.compliance?.byState).toBeNull();
    expect(s.dataGaps?.length).toBeGreaterThan(0);
  });

  // NOTE: `loadDomainFreshness` is mocked here, so this asserts the generator
  // passes the reader's `asOf` through unchanged and derives staleness from it.
  // That the reader itself picks `last_complete_snapshot_at` over
  // `last_success_at` is proven in m365Sync/summary.test.ts and, end to end on
  // real Postgres, in endpointManagementEvidence.integration.test.ts case 2.
  it('passes the reader asOf straight through and derives staleness from it', async () => {
    freshness({
      intune_devices: {
        asOf: '2026-09-02T04:00:00.000Z', lastStatus: 'partial', truncated: true, sources: {}, unlicensed: false,
      },
    });
    queueSelects(ORG_ROW, [], [{ id: 'x', breezeDeviceId: null }], [], [], []);

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP));
    expect(s.freshness?.intune_devices?.asOf).toBe('2026-09-02T04:00:00.000Z');
    expect(s.freshness?.intune_devices?.stale).toBe(true);
    expect(s.freshness?.intune_devices?.note).toMatch(/stale/i);
  });

  it('names a needs_consent domain as a gap instead of reporting zeros', async () => {
    freshness({
      intune_devices: { ...NEVER_RAN, sources: { managedDevices: 'needs_consent' } },
    });
    queueSelects(ORG_ROW, []);

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED));
    expect(s.enrolment?.intuneDevices).toBeNull();
    expect(s.dataGaps?.join(' ')).toMatch(/consent/i);
  });

  // Every outcome `isMeasured()` treats as unmeasured gets its own case. A
  // regression that dropped one from the list would silently start printing
  // real-looking numbers for a domain that was never enumerated — the exact
  // failure mode this report is written against — and a single needs_consent
  // case would not catch it.
  it.each([
    ['throttled', { sources: { managedDevices: 'throttled' } }],
    ['error', { sources: { managedDevices: 'error' } }],
    ['unlicensed', { sources: { managedDevices: 'ok' }, unlicensed: true }],
  ] as const)('treats a %s domain as unmeasured, not as an empty tenant', async (_label, over) => {
    freshness({
      // A COMPLETE, RECENT snapshot — so `asOf` alone cannot be what makes this
      // unmeasured. Only the outcome under test can.
      intune_devices: { ...MEASURED, ...over },
    });
    queueSelects(ORG_ROW, []);

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED));
    expect(s.enrolment?.intuneDevices).toBeNull();
    expect(s.enrolment?.intuneWithoutBreezeLink).toBeNull();
    expect(s.compliance?.byState).toBeNull();
    expect(s.staleEnrolments?.count).toBeNull();
  });

  it('treats an unlicensed skus domain as unmeasured licences, not an empty SKU list', async () => {
    freshness({ skus: { ...MEASURED, unlicensed: true } });
    queueSelects(ORG_ROW, [], [], [], [], []);

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED));
    // null = unmeasured; [] would read as "measured, this tenant owns no SKUs".
    expect(s.licences).toBeNull();
  });

  it('discloses the unlinked Intune population as a COUNT under a restricted authority, never enumerating it', async () => {
    queueSelects(
      ORG_ROW,
      [{ id: 'd0000000-0000-4000-8000-000000000001', siteId: SITE_A }],
      [{ id: 'a', breezeDeviceId: 'd0000000-0000-4000-8000-000000000001' }, { id: 'b', breezeDeviceId: null }],
      [intuneRow({ id: 'a' })],
      [],
      [],
    );

    const res = await generateEndpointManagementReport(ORG, {}, AUTH_RESTRICTED_S1);
    const s = summaryOf(res);
    expect(s.enrolment?.intuneWithoutBreezeLink).toBe(1);
    // The reported enrolment total is the IN-SCOPE linked population plus that
    // unlinked count — 1 + 1 — not the org-wide coverage row count. Reporting
    // the latter told a site-restricted technician the whole tenant's
    // enrolment scale beside a correctly-scoped Breeze device count.
    expect(s.enrolment?.intuneDevices).toBe(2);
    // The load-bearing assertion: the unlinked device must not appear in rows —
    // enumerating it leaks a device outside the technician's sites.
    expect((res.rows as IntuneDeviceRow[]).map((r) => r.id)).toEqual(['a']);
    expect((res.rows as IntuneDeviceRow[]).every((r) => r.breezeDeviceId)).toBe(true);
  });

  it('never reports an enrolment total larger than the authority can account for', async () => {
    // Three linked Intune rows org-wide, but only ONE joins to a device in the
    // permitted site; the row query returns just that one.
    queueSelects(
      ORG_ROW,
      [{ id: 'd1' }],
      [
        { id: 'a', breezeDeviceId: 'd1' },
        { id: 'b', breezeDeviceId: 'd2' },
        { id: 'c', breezeDeviceId: 'd3' },
      ],
      [intuneRow({ id: 'a', breezeDeviceId: 'd1' })],
      [],
      [],
    );

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_RESTRICTED_S1));
    // Not 3. The two rows joined to devices outside the permitted site are
    // neither listed nor counted.
    expect(s.enrolment?.intuneDevices).toBe(1);
    expect(s.enrolment?.intuneWithoutBreezeLink).toBe(0);
  });

  it('counts the whole org for an unrestricted authority with no site filter', async () => {
    queueSelects(
      ORG_ROW,
      [{ id: 'd1' }, { id: 'd2' }],
      [{ id: 'a', breezeDeviceId: 'd1' }, { id: 'b', breezeDeviceId: 'd2' }, { id: 'c', breezeDeviceId: null }],
      [intuneRow({ id: 'a', breezeDeviceId: 'd1' }), intuneRow({ id: 'b', breezeDeviceId: 'd2' })],
      [],
      [],
    );

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED));
    expect(s.enrolment?.intuneDevices).toBe(3);
    expect(s.enrolment?.intuneWithoutBreezeLink).toBe(1);
  });

  it('takes the trend from m365_posture_rollups, not from entity columns', async () => {
    queueSelects(
      ORG_ROW,
      [],
      [{ id: 'a', breezeDeviceId: null }],
      [],
      [{ rollupDate: '2026-09-29', devicesCompliant: 40, devicesNoncompliant: 2, devicesInGrace: 1, devicesUnknown: 0 }],
      [],
    );

    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP));
    expect(s.compliance?.trend?.[0]).toMatchObject({ date: '2026-09-29', compliant: 40 });
  });

  it('states the entity-history caveat on every artifact', async () => {
    queueSelects(ORG_ROW, [], [], [], [], []);
    // last_changed_at churns on every check-in (intuneDevices.ts:54-74) and stale
    // entities are deleted after 30 days, so device-level history does not exist.
    // The artifact must say so rather than let a reader infer it.
    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED));
    expect(s.historyCaveat).toBeTruthy();

    freshness({ intune_devices: NEVER_RAN });
    queueSelects(ORG_ROW, []);
    expect(summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED)).historyCaveat).toBeTruthy();
  });

  it('returns an empty-but-shaped result for a restricted authority with zero sites', async () => {
    const res = await generateEndpointManagementReport(ORG, {}, AUTH_RESTRICTED_ZERO);
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(res.summary).toBeTruthy();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('counts stale enrolments against the configured threshold, not the reporting period', async () => {
    queueSelects(
      ORG_ROW,
      [],
      [{ id: 'a', breezeDeviceId: 'd1' }, { id: 'b', breezeDeviceId: 'd2' }],
      [
        intuneRow({ id: 'a', breezeDeviceId: 'd1', lastIntuneSyncAt: new Date('2026-09-29T00:00:00Z') }),
        intuneRow({ id: 'b', breezeDeviceId: 'd2', lastIntuneSyncAt: new Date('2026-09-01T00:00:00Z') }),
      ],
      [],
      [],
    );

    const s = summaryOf(await generateEndpointManagementReport(
      ORG, { staleEnrolmentDays: 14 }, AUTH_UNRESTRICTED, PERIOD_SEP,
    ));
    // 2026-09-01 is 29 days before the 2026-09-30 run: stale, even though it
    // sits inside the September reporting period.
    expect(s.staleEnrolments).toEqual({ count: 1, thresholdDays: 14 });
  });

  it('omits licences entirely when includeLicences is false, without querying for them', async () => {
    queueSelects(ORG_ROW, [], [], [], [], [{ skuPartNumber: 'SPE_E3', consumedUnits: 4, prepaidEnabled: 5 }]);
    const s = summaryOf(await generateEndpointManagementReport(
      ORG, { includeLicences: false }, AUTH_UNRESTRICTED,
    ));
    expect(s.licences).toBeUndefined();
  });

  it('uses the evidence window rather than now() when one is supplied', async () => {
    queueSelects(ORG_ROW, [], [], [], [], []);
    const s = summaryOf(await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP));
    expect(s.period).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(s.generatedAt).toBe('2026-09-30T06:00:00.000Z');
  });
});
