import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
  // #5784 W04: vulnerability_management's shared loader elevates the GLOBAL CVE
  // catalog read out of the request's org context, so the parameterized arms
  // below reach these two. They pass the callback straight through — the site
  // scope under test is bound by the DEVICE query, not by the context helper.
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { db } from '../db';
import type { OrgReportExecutionAuthority, ReportExecutionAuthority } from './siteScope';
import {
  assertReportExecutionPreflight,
  generateDeviceInventoryReport,
  generateReport,
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
  type ReportType,
} from './reportGenerationService';
import { organizationScope } from './reportScope';
import { reportTypeEnum } from '../db/schema/reports';
import { organizations } from '../db/schema';
import { REPORT_TYPES as SHARED_REPORT_TYPES } from '@breeze/shared';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPORT_TYPES: readonly ReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  'hardware_lifecycle',
  'threat_detection_review',
  'endpoint_management_review',
  'vulnerability_management',
  'identity_access_review',
];
/**
 * #5784 W06. `identity_access_review` is org-wide by construction: M365 identity
 * data has no site dimension, so a RESTRICTED authority is refused outright
 * (OD-8 = A) and the generator reads nothing at all. It therefore cannot bind a
 * site predicate, and the site-binding matrix below excludes it — with a
 * dedicated assertion in its place, so the exclusion is proven, not assumed.
 */
const SITE_SCOPED_REPORT_TYPES: readonly ReportType[] = REPORT_TYPES
  .filter((type) => type !== 'identity_access_review');
/** Every `ReportType` that is NOT generated on demand. P2-3 added the first
 *  one: a weekly AI narrative's artifact is written once by the agent run and
 *  only ever read back — there is no query that could reproduce it. Fleet
 *  Designer W01 (#5651) added the second, same shape. */
const STORED_ARTIFACT_ONLY_TYPES: readonly ReportType[] = ['ai_org_narrative', 'ai_fleet_design'];
/** #3198 W01. Business report types that exist as enum labels only: W02
 *  registers their generators. Until then every generation entry point
 *  refuses them with `UnsupportedReportScopeError`. */
const GENERATOR_LESS_BUSINESS_TYPES: readonly ReportType[] = [
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
];
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';

const capturedWhere: SQL[] = [];

function selectChain(rows: unknown[] = []) {
  const chain: any = Promise.resolve(rows);
  for (const method of [
    'from',
    'innerJoin',
    'leftJoin',
    'orderBy',
    'groupBy',
    'limit',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.where = vi.fn((condition: SQL) => {
    capturedWhere.push(condition);
    return chain;
  });
  return chain;
}

function authority(
  kind: 'unrestricted' | 'restricted',
  siteIds: string[] = [],
  orgId = ORG_ID,
): OrgReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId, siteIds }
      : { version: 1, kind, orgId },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-07-25T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

function portalAuthority(): OrgReportExecutionAuthority {
  return {
    principalKind: 'portal_user',
    scope: { version: 1, kind: 'unrestricted', orgId: ORG_ID },
    capturedAt: new Date('2026-07-25T12:00:00.000Z'),
    fingerprint: 'f'.repeat(64),
  };
}

function renderedParams(): unknown[] {
  const dialect = new PgDialect();
  return capturedWhere.flatMap((condition) =>
    dialect.sqlToQuery(condition).params
  );
}

describe('generateReport mandatory execution authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it('rejects a missing authority before the first report query', async () => {
    await expect(
      generateReport(
        'device_inventory',
        organizationScope(ORG_ID),
        {},
        undefined as never,
      ),
    ).rejects.toThrow(/authority|scope/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects an authority for another organization before querying', async () => {
    await expect(
      generateReport(
        'device_inventory',
        organizationScope(ORG_ID),
        {},
        authority('unrestricted', [], OTHER_ORG_ID),
      ),
    ).rejects.toThrow(/organization|scope/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each(REPORT_TYPES)(
    '%s returns its zero-safe shape for restricted-empty without querying',
    async (type) => {
      const result = await generateReport(
        type,
        organizationScope(ORG_ID),
        {},
        authority('restricted', []),
      );

      expect(db.select).not.toHaveBeenCalled();
      if (type === 'executive_summary') {
        expect(result.summary).toMatchObject({
          devices: { total: 0 },
          alerts: { total: 0 },
        });
      } else {
        expect(result.rows).toEqual([]);
        expect(result.rowCount).toBe(0);
      }
    },
  );

  // #5784 W04. This arm must NOT be the bare `emptyRowsReport()` the other
  // row-shaped types get: a summary-less result falls through buildReportPdf's
  // arm to renderGenericReport, whose "No data available for the selected
  // filters." is indistinguishable from "we checked every device and found
  // none". Nothing was queried, so the counts are UNMEASURED, and the artifact
  // has to say which of the two happened.
  it('vulnerability_management returns a shaped, unmeasured summary for restricted-empty, not a bare empty result', async () => {
    const result = await generateReport(
      'vulnerability_management',
      organizationScope(ORG_ID),
      {},
      authority('restricted', []),
    );

    expect(db.select).not.toHaveBeenCalled();
    const summary = result.summary as {
      open?: { critical: number | null; knownExploited: number | null };
      dataGaps?: string[];
      closedThisPeriod?: { count: number | null };
    };
    expect(summary).toBeTruthy();
    expect(summary.open?.critical).toBeNull();
    expect(summary.open?.knownExploited).toBeNull();
    expect(summary.closedThisPeriod?.count).toBeNull();
    expect(summary.dataGaps?.join(' ')).toMatch(/no sites in scope/i);
  });

  it.each(['executive_summary', 'security_compliance_posture', 'hardware_lifecycle'] as const)(
    'allows portal-user authority for %s',
    async (type) => {
      await expect(generateReport(type, organizationScope(ORG_ID), {}, portalAuthority()))
        .resolves.toBeDefined();
    },
  );

  it.each([
    'device_inventory',
    'software_inventory',
    'alert_summary',
    'compliance',
    'performance',
    'ai_org_narrative',
  ] as const)('rejects portal-user authority for %s before querying', async (type) => {
    await expect(generateReport(type, organizationScope(ORG_ID), {}, portalAuthority()))
      .rejects.toThrow(/portal|authority|report type/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects portal-user authority at a non-canonical generator entry point', async () => {
    await expect(
      generateDeviceInventoryReport(ORG_ID, {}, portalAuthority()),
    ).rejects.toThrow(/portal|authority|report type/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each(['executive_summary', 'security_compliance_posture', 'hardware_lifecycle'] as const)(
    'allows portal-user authority through the shared preflight for %s',
    (type) => {
      expect(() => assertReportExecutionPreflight(
        ORG_ID,
        {},
        portalAuthority(),
        type,
      )).not.toThrow();
    },
  );

  it('identity_access_review refuses a restricted authority instead of binding a site scope', async () => {
    const result = await generateReport(
      'identity_access_review',
      organizationScope(ORG_ID),
      {},
      authority('restricted', [SITE_A]),
    );

    // OD-8 = A: an org-wide identity view served to a site-restricted technician
    // would be a scope escalation, so the answer is the empty-but-shaped result
    // and NOTHING IDENTITY-SHAPED is read. The one permitted read is the org's
    // own display name (#6100) — an evidence PDF must name its customer — so
    // the guard is "exactly one select, against organizations, keyed by org id",
    // not "no select at all".
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(renderedParams()).not.toContain(SITE_A);
    expect(db.select).toHaveBeenCalledTimes(1);
    const chain = vi.mocked(db.select).mock.results[0]!.value as any;
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledWith(organizations);
    expect(renderedParams()).toEqual([ORG_ID]);
  });

  it.each(SITE_SCOPED_REPORT_TYPES)(
    '%s binds the exact restricted site scope and never Site B',
    async (type) => {
      await generateReport(
        type,
        organizationScope(ORG_ID),
        {},
        authority('restricted', [SITE_A]),
      );

      const params = renderedParams();
      expect(params).toContain(SITE_A);
      expect(params).not.toContain(SITE_B);
    },
  );

  // #5784 W03. The generic `emptyRowsReport()` shape carries NO summary, and
  // buildReportPdf's endpoint-management arm is guarded on the summary being
  // present — so that shape degrades the artifact to renderGenericReport's
  // one-line "No data available for the selected filters". A technician with no
  // permitted sites must be told that, not shown a blank all-clear.
  it('endpoint_management_review returns a SHAPED zero-safe summary, not a bare empty result', async () => {
    const result = await generateReport(
      'endpoint_management_review',
      organizationScope(ORG_ID),
      {},
      authority('restricted', []),
    );

    expect(db.select).not.toHaveBeenCalled();
    const summary = result.summary as Record<string, unknown> | undefined;
    expect(summary).toBeTruthy();
    expect(summary).toMatchObject({
      enrolment: {
        intuneDevices: null, breezeDevices: null, breezeWithoutIntune: null, intuneWithoutBreezeLink: null,
      },
      compliance: { byState: null },
    });
    expect(Array.isArray(summary?.rows)).toBe(true);
    expect(summary?.historyCaveat).toBeTruthy();
    expect(summary?.dataGaps).toEqual([expect.stringMatching(/No sites are in scope/)]);
  });

  it.each(REPORT_TYPES)(
    '%s preserves unrestricted generation without a site predicate',
    async (type) => {
      await generateReport(
        type,
        organizationScope(ORG_ID),
        {},
        authority('unrestricted'),
      );

      expect(renderedParams()).not.toContain(SITE_A);
      expect(renderedParams()).not.toContain(SITE_B);
    },
  );
});

/**
 * P2-3 (#4190) — `ai_org_narrative` is a STORED artifact, not a generated one.
 * Its `report_runs` row is written once, inside the agent run's transaction
 * (`persistNarrativeReport`), from a model-authored narrative that no query
 * could reproduce. Every generation entry point must therefore refuse it
 * rather than fall through to a `never` check whose message ("Invalid report
 * type") would read as a bug in the type union.
 */
describe('stored-artifact-only report types (P2-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it.each(STORED_ARTIFACT_ONLY_TYPES)(
    '%s is refused by the dispatch switch before any query runs',
    async (type) => {
      await expect(
        generateReport(type, organizationScope(ORG_ID), {}, authority('unrestricted')),
      ).rejects.toBeInstanceOf(StoredArtifactOnlyReportError);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it.each(STORED_ARTIFACT_ONLY_TYPES)(
    '%s is refused by the ZERO-SAFE branch too, which the dispatch switch never reaches',
    async (type) => {
      // A restricted-empty authority short-circuits into `zeroSafeReport`
      // before the dispatch switch — a second exhaustive switch, and the one
      // that would otherwise hand back a plausible-looking empty report for a
      // document that exists.
      await expect(
        generateReport(type, organizationScope(ORG_ID), {}, authority('restricted', [])),
      ).rejects.toBeInstanceOf(StoredArtifactOnlyReportError);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it('carries the stable code routes map to 409', async () => {
    const error = await generateReport('ai_org_narrative', organizationScope(ORG_ID), {}, authority('unrestricted'))
      .catch((e: unknown) => e as StoredArtifactOnlyReportError);

    expect(error).toBeInstanceOf(StoredArtifactOnlyReportError);
    expect((error as StoredArtifactOnlyReportError).code).toBe('stored_artifact_only');
  });

  it('the API-local ReportType union covers exactly the DB enum, with no type unaccounted for', () => {
    // Drift guard: `reportGenerationService.ts` keeps its own union rather than
    // deriving from the pgEnum, and a value added to one and not the other is
    // a `never`-check failure at a call site far from either file.
    expect([...REPORT_TYPES, ...STORED_ARTIFACT_ONLY_TYPES, ...GENERATOR_LESS_BUSINESS_TYPES].sort())
      .toEqual([...reportTypeEnum.enumValues].sort());
  });

  it('#3198 W02: the canonical @breeze/shared REPORT_TYPES tuple equals the DB enum, IN ORDER', () => {
    // Pins the shared tuple (packages/shared/src/reportTypes.ts) against the
    // pgEnum's declared order. The pgEnum is the shipped database fact and
    // cannot be spread from the tuple (a later author might reorder it), so
    // this is the one place order is checked, not just membership.
    expect([...SHARED_REPORT_TYPES]).toEqual([...reportTypeEnum.enumValues]);
  });
});

describe('managed evidence system execution path (#5784 OD-5 = B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it('refuses a system authority for a type outside the managed evidence registry, before any query', async () => {
    const { generateManagedEvidenceReport } = await import('./reportGenerationService');
    await expect(
      generateManagedEvidenceReport('device_inventory' as never, ORG_ID, {}, undefined),
    ).rejects.toThrow(/not a managed evidence type/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a system authority whose scope is not org-wide unrestricted', () => {
    expect(() => assertReportExecutionPreflight(ORG_ID, {}, {
      principalKind: 'system',
      // A restricted scope can never be stamped on an org-wide managed result.
      scope: { version: 1, kind: 'restricted', orgId: ORG_ID, siteIds: [] },
      fingerprint: 'x',
      capturedAt: new Date(),
    } as never, 'device_inventory')).toThrow(/unrestricted/i);
  });

  it('mints a system authority that is org-wide unrestricted with a matching fingerprint', async () => {
    const { systemReportAuthorityFor, siteScopeFingerprint } = await import('./siteScope');
    const got = systemReportAuthorityFor(ORG_ID);
    expect(got.principalKind).toBe('system');
    expect(got.scope).toEqual({ version: 1, kind: 'unrestricted', orgId: ORG_ID });
    expect(got.fingerprint).toBe(siteScopeFingerprint(got.scope));
    // The preflight accepts exactly this shape.
    expect(() => assertReportExecutionPreflight(ORG_ID, {}, got as never, 'device_inventory')).not.toThrow();
  });

  it('leaves the ordinary user path unchanged: a user authority with an empty restricted scope still reaches the zero-safe shape', async () => {
    const result = await generateReport('device_inventory', organizationScope(ORG_ID), {}, authority('restricted', []));
    expect(result.rowCount).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('generator-less business report types (#3198 W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it.each(GENERATOR_LESS_BUSINESS_TYPES)(
    '%s is refused by the dispatch switch with UnsupportedReportScopeError before any query',
    async (type) => {
      const error = await generateReport(type, organizationScope(ORG_ID), {}, authority('unrestricted'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedReportScopeError);
      expect((error as Error).message).toBe(`${type} cannot run at organization scope`);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it.each(GENERATOR_LESS_BUSINESS_TYPES)(
    // #3198 W02 (P1b): tickets, time entries and invoices carry no site axis, so
    // a site-restricted authority queried NOTHING. Unlike the dispatch-switch
    // refusal above, the zero-safe branch does NOT throw — it hands back an
    // empty-but-shaped summary carrying the site-restricted note, the same
    // "not measured, not zero" contract as every other zero-safe business arm.
    '%s zero-safe branch returns an empty-but-shaped summary carrying the site-restricted note, NOT a throw',
    async (type) => {
      const result = await generateReport(type, organizationScope(ORG_ID), {}, authority('restricted', []));
      expect(result.rowCount).toBe(0);
      expect(result.rows).toEqual([]);
      expect(result.summary).toBeDefined();
      expect((result.summary as { notes: string[] }).notes).toEqual([
        'This report ran under a site-restricted authority. Tickets, time entries and '
        + 'invoices have no site dimension, so nothing was queried — the figures below '
        + 'are not measured, and they are not zero.',
      ]);
      expect(db.select).not.toHaveBeenCalled();
    },
  );
});

describe('assertReportExecutionPreflight owner axis (#3198 W01)', () => {
  function partnerWideAuthority(partnerId = PARTNER_ID) {
    return {
      principalKind: 'user' as const,
      scope: { version: 1 as const, kind: 'partner_wide' as const, partnerId },
      principalUserId: USER_ID,
      capturedAt: new Date('2026-09-21T12:00:00.000Z'),
      fingerprint: 'e'.repeat(64),
    };
  }

  it('accepts a partner_wide user authority for the owning partner', () => {
    expect(() => assertReportExecutionPreflight(
      { partnerId: PARTNER_ID }, {}, partnerWideAuthority(), 'ar_aging',
    )).not.toThrow();
  });

  it('refuses a partner_wide authority for another partner', () => {
    expect(() => assertReportExecutionPreflight(
      { partnerId: PARTNER_ID }, {}, partnerWideAuthority('55555555-5555-4555-8555-555555555555'),
    )).toThrow(UnexecutableReportScopeError);
  });

  it('refuses an org authority on a partner-owned report', () => {
    expect(() => assertReportExecutionPreflight(
      { partnerId: PARTNER_ID }, {}, authority('unrestricted'),
    )).toThrow(/partner authority mismatch/);
  });

  it('refuses a partner_wide authority on an org-owned report', () => {
    expect(() => assertReportExecutionPreflight(
      { orgId: ORG_ID }, {}, partnerWideAuthority(),
    )).toThrow(/organization mismatch/);
    expect(() => assertReportExecutionPreflight(
      ORG_ID, {}, partnerWideAuthority(),
    )).toThrow(/organization mismatch/);
  });

  it('keeps the org-owned path byte-for-byte: { orgId } and a bare org id behave the same', () => {
    expect(() => assertReportExecutionPreflight({ orgId: ORG_ID }, {}, authority('unrestricted'))).not.toThrow();
    expect(() => assertReportExecutionPreflight({ orgId: OTHER_ORG_ID }, {}, authority('unrestricted')))
      .toThrow(/organization mismatch/);
  });

  it('keeps the portal-user report-type gate (4th parameter)', () => {
    expect(() => assertReportExecutionPreflight({ orgId: ORG_ID }, {}, portalAuthority(), 'device_inventory'))
      .toThrow(/Portal-user authority cannot generate report type device_inventory/);
  });
});

describe('registry dispatch gate order (#3198 W02 Task 3)', () => {
  const PARTNER_SCOPE = { kind: 'partner' as const, partnerId: PARTNER_ID, orgIds: [ORG_ID] };
  function partnerWideAuthority(): ReportExecutionAuthority {
    return {
      principalKind: 'user',
      scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER_ID },
      principalUserId: USER_ID,
      capturedAt: new Date('2026-09-21T12:00:00.000Z'),
      fingerprint: 'e'.repeat(64),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it.each(REPORT_TYPES)(
    'org-only %s under a partner scope is UnsupportedReportScopeError(partner), checked BEFORE the preflight',
    async (type) => {
      // An org authority against a partner owner would fail the preflight with
      // "partner authority mismatch" (403 shape) if the preflight ran first.
      const error = await generateReport(type, PARTNER_SCOPE, {}, authority('unrestricted'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedReportScopeError);
      expect((error as UnsupportedReportScopeError).scope).toBe('partner');
      expect((error as Error).message).toBe(`${type} cannot run at partner scope`);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it.each(GENERATOR_LESS_BUSINESS_TYPES)(
    '%s passes the partner-scope gate and the partner preflight, then its placeholder refuses',
    async (type) => {
      const error = await generateReport(type, PARTNER_SCOPE, {}, partnerWideAuthority())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedReportScopeError);
      expect((error as UnsupportedReportScopeError).scope).toBe('partner');
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it('a business type under a partner scope still runs the partner preflight (wrong partner → 403 shape)', async () => {
    await expect(generateReport(
      'ar_aging',
      { kind: 'partner', partnerId: '55555555-5555-4555-8555-555555555555', orgIds: [] },
      {},
      partnerWideAuthority(),
    )).rejects.toThrow(/partner authority mismatch/);
  });
});

describe('partner preflight refuses org/site selectors in config (#3198 W02, addendum B5)', () => {
  function partnerWideAuthority() {
    return {
      principalKind: 'user' as const,
      scope: { version: 1 as const, kind: 'partner_wide' as const, partnerId: PARTNER_ID },
      principalUserId: USER_ID,
      capturedAt: new Date('2026-09-21T12:00:00.000Z'),
      fingerprint: 'e'.repeat(64),
    };
  }
  const owner = { partnerId: PARTNER_ID };

  // A partner-scope generator runs in a context wider than one org; any of
  // these would either widen past or re-target the partner's own org set.
  it.each([
    ['filters.siteIds', { filters: { siteIds: [SITE_A] } }],
    ['filters.deviceIds', { filters: { deviceIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] } }],
    ['sites', { sites: [SITE_A] }],
    ['orgId', { orgId: OTHER_ORG_ID }],
    ['orgIds', { orgIds: [OTHER_ORG_ID] }],
    ['a malformed (non-array) sites value', { sites: SITE_A }],
    ['a malformed (non-object) filters value', { filters: 'x' }],
  ])('refuses %s', (_label, config) => {
    expect(() => assertReportExecutionPreflight(
      owner, config as Record<string, unknown>, partnerWideAuthority(), 'ar_aging',
    )).toThrow(/partner-scope report config cannot select/);
    expect(() => assertReportExecutionPreflight(
      owner, config as Record<string, unknown>, partnerWideAuthority(), 'ar_aging',
    )).toThrow(UnexecutableReportScopeError);
  });

  it('accepts a config with no selectors, or with empty selector arrays (= no filter)', () => {
    for (const config of [
      {},
      { period: 'last_month', filters: {} },
      { sites: [], filters: { siteIds: [], deviceIds: [] }, orgIds: [] },
      { filters: { status: ['open'], severity: ['high'] } },
    ]) {
      expect(() => assertReportExecutionPreflight(owner, config, partnerWideAuthority(), 'ar_aging'))
        .not.toThrow();
    }
  });

  // #3198 W02 (ruling T3e). Loose schemas pass any undeclared key, so the
  // denylist above stays; in addition the config must parse under the TYPE's
  // own schema — a stored config the type rejects never reaches a generator
  // running wider than one org.
  it('refuses a config the report type\'s own schema rejects', () => {
    for (const config of [{ groupBy: 42 }, { emailRecipients: ['not-an-email'] }, { schedule: { time: '25:99' } }]) {
      expect(() => assertReportExecutionPreflight(
        owner, config as Record<string, unknown>, partnerWideAuthority(), 'ar_aging',
      )).toThrow(UnexecutableReportScopeError);
    }
  });

  it('the schema check needs the type: without one only the denylist applies', () => {
    expect(() => assertReportExecutionPreflight(
      owner, { groupBy: 42 } as Record<string, unknown>, partnerWideAuthority(),
    )).not.toThrow();
  });

  it('does not change the org-owned path: an in-scope filters.siteIds still passes there', () => {
    expect(() => assertReportExecutionPreflight(
      ORG_ID, { filters: { siteIds: [SITE_A] } }, authority('restricted', [SITE_A]), 'device_inventory',
    )).not.toThrow();
  });
});
