import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drizzle mock pattern copied from threatDetectionReport.test.ts /
// hardwareLifecycleReport.test.ts: every `db.select()` call resolves the next
// queued row set, in call order.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

const { freshnessMock } = vi.hoisted(() => ({ freshnessMock: vi.fn() }));
vi.mock('./m365Sync/summary', () => ({ loadDomainFreshness: freshnessMock }));

const { syncEnabledMock } = vi.hoisted(() => ({ syncEnabledMock: vi.fn(() => true) }));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isM365TenantSyncEnabled: syncEnabledMock,
}));

import type { IdentityAccessSummary } from '@breeze/shared';
import { db } from '../db';
import { generateIdentityAccessReport } from './identityAccessReport';
import type { EvidenceRunContext, ReportResult } from './reportGenerationService';
import type { ReportGenerationAuthority } from './siteScope';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PERIOD_SEP: EvidenceRunContext = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  generatedAt: '2026-09-30T05:18:00.000Z',
  deliverableId: 'd0000000-0000-4000-8000-0000000000d1',
};

function summaryOf(result: ReportResult): IdentityAccessSummary {
  return result.summary as IdentityAccessSummary;
}

function queueSelects(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.select).mockImplementation((() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy', 'where']) {
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
): ReportGenerationAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG_ID, siteIds }
      : { version: 1, kind, orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-30T05:18:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

const ORG_ROW = [{ id: ORG_ID, name: 'Acme Legal' }];

const ADMIN_UPN = 'root@acme.example';

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    userPrincipalName: 'user@acme.example',
    displayName: 'A User',
    accountEnabled: true,
    isAdmin: false,
    mfaRegistered: true,
    lastSuccessfulSignInAt: new Date('2026-09-25T00:00:00.000Z'),
    isStale: false,
    ...overrides,
  };
}

function signinRow(overrides: Record<string, unknown> = {}) {
  return {
    signedInAt: new Date('2026-09-10T00:00:00.000Z'),
    userPrincipalName: 'user@acme.example',
    appDisplayName: 'Outlook',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.10',
    locationCity: 'Austin',
    locationCountry: 'US',
    conditionalAccessStatus: 'success',
    statusErrorCode: 0,
    riskLevelAggregated: 'none',
    ...overrides,
  };
}

function caRow(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'MFA for admins',
    state: 'enabled',
    lastChangedAt: new Date('2026-09-15T00:00:00.000Z'),
    isStale: false,
    ...overrides,
  };
}

/** The select order the generator issues, so each test queues the right sets. */
function queueHappyPath(opts: {
  users?: unknown[];
  signins?: unknown[];
  ca?: unknown[];
  devices?: unknown[];
  rollup?: unknown[];
  earliest?: unknown[];
} = {}) {
  queueSelects(
    ORG_ROW,
    opts.rollup ?? [],
    opts.users ?? [userRow()],
    opts.signins ?? [signinRow()],
    opts.earliest ?? [{ earliest: new Date('2026-09-01T00:00:00.000Z'), latest: new Date('2026-09-30T00:00:00.000Z') }],
    opts.ca ?? [caRow()],
    opts.devices ?? [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  syncEnabledMock.mockReturnValue(true);
  freshnessMock.mockResolvedValue({
    signin_events: {
      asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success',
      truncated: false, sources: { signinEvents: 'ok' }, unlicensed: false,
    },
    users: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', truncated: false, sources: null, unlicensed: false },
    ca_policies: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', truncated: false, sources: null, unlicensed: false },
  });
});

describe('generateIdentityAccessReport', () => {
  it('returns the zero-safe shape for a RESTRICTED authority, with an explanatory gap line', async () => {
    queueHappyPath();
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority('restricted', [SITE_A]), PERIOD_SEP);
    // OD-8 = A. M365 identity has no site dimension; serving it to a
    // site-restricted technician would be a scope escalation.
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(summaryOf(res).dataGaps?.join(' ')).toMatch(/org-wide/i);
    // And nothing at all was read.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('never leaks an identity row into the restricted result', async () => {
    queueHappyPath({ users: [userRow({ isAdmin: true, userPrincipalName: ADMIN_UPN })] });
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority('restricted', [SITE_A]), PERIOD_SEP);
    const s = summaryOf(res);
    expect(s.identity?.usersTotal).toBeNull();
    expect(s.adminSignins ?? null).toBeNull();
    expect(JSON.stringify(s)).not.toContain(ADMIN_UPN);
  });

  it('renders a data-gap page for an unlicensed tenant, never an empty table', async () => {
    freshnessMock.mockResolvedValue({
      signin_events: {
        asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success',
        truncated: false, sources: { signinEvents: 'unlicensed' }, unlicensed: true,
      },
      users: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
      ca_policies: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
    });
    queueHappyPath({ signins: [] });
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP);
    const s = summaryOf(res);
    expect(s.coverage?.unlicensed).toBe(true);
    expect(s.signins?.total).toBeNull();           // unmeasured, NOT zero
    expect(s.dataGaps?.join(' ')).toMatch(/licen[cs]e/i);
  });

  it('states the actual coverage window when Breeze started collecting mid-period', async () => {
    queueHappyPath({
      earliest: [{ earliest: new Date('2026-09-20T00:00:00.000Z'), latest: new Date('2026-09-30T00:00:00.000Z') }],
    });
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP);
    const s = summaryOf(res);
    expect(s.coverage?.coveredFrom).toBe('2026-09-20T00:00:00.000Z');
    expect(s.coverage?.note).toMatch(/does not cover/i);
  });

  it('treats mfa_registered NULL as unknown, never as not registered', async () => {
    queueHappyPath({
      users: [
        userRow({ isAdmin: true, mfaRegistered: null, userPrincipalName: 'a1@acme.example' }),
        userRow({ isAdmin: true, mfaRegistered: false, userPrincipalName: 'a2@acme.example' }),
      ],
    });
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP);
    const s = summaryOf(res);
    expect(s.identity?.adminsWithoutMfa).toBe(1);
    expect(s.identity?.adminsMfaUnknown).toBe(1);
  });

  it('renders the risk section unmeasured when every value is Graph’s hidden sentinel', async () => {
    queueHappyPath({
      signins: [signinRow({ riskLevelAggregated: 'hidden' }), signinRow({ riskLevelAggregated: 'hidden' })],
    });
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP);
    expect(summaryOf(res).signins?.byRiskLevel).toBeNull();
  });

  it('counts the measured risk values when at least one is real', async () => {
    queueHappyPath({
      signins: [signinRow({ riskLevelAggregated: 'hidden' }), signinRow({ riskLevelAggregated: 'high' })],
    });
    expect(summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP))
      .signins?.byRiskLevel).toEqual({ high: 1 });
  });

  it('reports outsideHomeCountries as null when none are configured', async () => {
    queueHappyPath({ signins: [signinRow({ locationCountry: 'RU' })] });
    const res = await generateIdentityAccessReport(ORG_ID, { homeCountries: [] }, authority(), PERIOD_SEP);
    // "Not configured" and "no foreign sign-ins" must not read the same.
    expect(summaryOf(res).signins?.outsideHomeCountries).toBeNull();
  });

  it('counts sign-ins outside the configured home countries', async () => {
    queueHappyPath({ signins: [signinRow({ locationCountry: 'RU' }), signinRow({ locationCountry: 'US' })] });
    const res = await generateIdentityAccessReport(ORG_ID, { homeCountries: ['US'] }, authority(), PERIOD_SEP);
    expect(summaryOf(res).signins?.outsideHomeCountries).toBe(1);
  });

  it('counts legacy authentication by client app, and failures by error code', async () => {
    queueHappyPath({
      signins: [
        signinRow({ clientAppUsed: 'IMAP4', statusErrorCode: 50126, conditionalAccessStatus: 'failure' }),
        signinRow({ clientAppUsed: 'Browser', statusErrorCode: 0 }),
      ],
    });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.signins?.legacyAuth).toEqual({ IMAP4: 1 });
    expect(s.signins?.failures).toBe(1);
    expect(s.signins?.failuresByErrorCode).toEqual({ '50126': 1 });
    expect(s.signins?.conditionalAccessFailures).toBe(1);
  });

  it('includes only admin sign-ins in the admin detail section, and omits it when adminDetail is off', async () => {
    const users = [
      userRow({ isAdmin: true, userPrincipalName: ADMIN_UPN }),
      userRow({ isAdmin: false, userPrincipalName: 'user@acme.example' }),
    ];
    const signins = [signinRow({ userPrincipalName: ADMIN_UPN }), signinRow({ userPrincipalName: 'user@acme.example' })];

    queueHappyPath({ users, signins });
    const on = summaryOf(await generateIdentityAccessReport(ORG_ID, { adminDetail: true }, authority(), PERIOD_SEP));
    expect(on.adminSignins?.length).toBe(1);
    expect(on.adminSignins?.every((r) => r.userPrincipalName === ADMIN_UPN)).toBe(true);
    expect(on.rows?.length).toBe(1);

    queueHappyPath({ users, signins });
    const off = summaryOf(await generateIdentityAccessReport(ORG_ID, { adminDetail: false }, authority(), PERIOD_SEP));
    expect(off.adminSignins).toBeNull();
    expect(off.rows).toEqual([]);
  });

  it('lists dormant accounts and keeps a never-observed sign-in as null', async () => {
    queueHappyPath({
      users: [
        userRow({ userPrincipalName: 'never@acme.example', lastSuccessfulSignInAt: null }),
        userRow({ userPrincipalName: 'old@acme.example', lastSuccessfulSignInAt: new Date('2026-01-01T00:00:00.000Z') }),
        userRow({ userPrincipalName: 'active@acme.example' }),
        userRow({ userPrincipalName: 'disabled@acme.example', accountEnabled: false, lastSuccessfulSignInAt: null }),
      ],
    });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, { dormantDays: 45 }, authority(), PERIOD_SEP));
    const upns = s.dormant?.rows.map((r) => r.userPrincipalName);
    expect(upns).toEqual(['never@acme.example', 'old@acme.example']);
    expect(s.dormant?.rows[0]?.lastSuccessfulSignInAt).toBeNull();
    expect(s.dormant?.thresholdDays).toBe(45);
  });

  it('flags CA policies changed inside the period and stale ones', async () => {
    queueHappyPath({
      ca: [
        caRow({ displayName: 'MFA for admins', state: 'enabled', lastChangedAt: new Date('2026-09-15T00:00:00.000Z'), isStale: false }),
        caRow({ displayName: 'Old rule', state: 'disabled', lastChangedAt: new Date('2026-01-01T00:00:00.000Z'), isStale: true }),
      ],
    });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.conditionalAccess?.changedThisPeriod).toBe(1);
    expect(s.conditionalAccess?.policies?.find((p) => p.displayName === 'Old rule')?.isStale).toBe(true);
  });

  it('labels remote access as client presence, not policy', async () => {
    queueHappyPath({
      devices: [{ activeVpns: [{ provider: 'tailscale', active: true }] }, { activeVpns: null }],
    });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.remoteAccess?.caveat).toMatch(/client presence/i);
    // The renderer prints this verbatim, so the string itself must never contain
    // the phrase "VPN policy review" — even to deny it (a reader skimming sees
    // the phrase, not the negation), and the PDF test asserts its absence.
    expect(s.remoteAccess?.caveat).not.toMatch(/VPN policy review/i);
    expect(s.remoteAccess?.byProvider).toEqual({ tailscale: 1 });
  });

  // Review finding (#6034): remoteAccess had no measured-gate, so an org whose
  // devices have never reported VPN presence got `{}` — which the renderer
  // prints as "None observed at last check-in", i.e. a measurement of zero over
  // data nobody collected.
  it('reports remote access as UNMEASURED when no device has ever reported presence', async () => {
    queueHappyPath({ devices: [{ activeVpns: null }, { activeVpns: null }] });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.remoteAccess).toBeNull();
    expect(s.dataGaps?.join(' ')).toMatch(/no device has reported/i);
    expect(s.dataGaps?.join(' ')).not.toMatch(/none observed/i);
  });

  it('reports remote access as UNMEASURED for an org with no devices at all', async () => {
    queueHappyPath({ devices: [] });
    expect(summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP)).remoteAccess)
      .toBeNull();
  });

  it('discloses the devices that have never reported rather than folding them into the total', async () => {
    queueHappyPath({
      devices: [
        { activeVpns: [{ provider: 'tailscale', active: true }] },
        { activeVpns: null },
      ],
    });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.remoteAccess?.byProvider).toEqual({ tailscale: 1 });
    expect(s.dataGaps?.join(' ')).toMatch(/1 device\(s\) have never reported/i);
  });

  it('does not count an installed-but-inactive remote-access client as presence', async () => {
    queueHappyPath({ devices: [{ activeVpns: [{ provider: 'tailscale', active: false }] }] });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    // Measured (the device reported), but nothing is up.
    expect(s.remoteAccess?.byProvider).toEqual({});
  });

  // Review finding (#6034): the identity "unmeasured" arm was never exercised —
  // every test seeded at least one user, so a regression that always computed
  // zeros would have passed.
  it('reports the identity inventory as UNMEASURED when no users have ever synced', async () => {
    queueHappyPath({ users: [], rollup: [] });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.identity?.usersTotal).toBeNull();
    expect(s.identity?.admins).toBeNull();
    expect(s.identity?.adminsWithoutMfa).toBeNull();
    expect(s.dormant).toBeNull();
    expect(s.dataGaps?.join(' ')).toMatch(/no microsoft 365 user inventory/i);
  });

  // Review finding (#6034): caMeasured has two independent inputs and they were
  // never varied apart, so collapsing it to `caRows.length > 0` would have gone
  // unnoticed — and would print "0 policies" for a tenant whose CA sync never ran.
  it('distinguishes "CA never synced" (null) from "synced, no policies" (empty)', async () => {
    freshnessMock.mockResolvedValue({
      signin_events: {
        asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success',
        truncated: false, sources: { signinEvents: 'ok' }, unlicensed: false,
      },
      users: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
      // The CA domain has NEVER run: no rows and no snapshot.
      ca_policies: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
    });
    queueHappyPath({ ca: [] });
    const neverSynced = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(neverSynced.conditionalAccess?.policies).toBeNull();
    expect(neverSynced.conditionalAccess?.changedThisPeriod).toBeNull();

    freshnessMock.mockResolvedValue({
      signin_events: {
        asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success',
        truncated: false, sources: { signinEvents: 'ok' }, unlicensed: false,
      },
      users: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
      ca_policies: {
        asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success',
        truncated: false, sources: null, unlicensed: false,
      },
    });
    queueHappyPath({ ca: [] });
    const syncedEmpty = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(syncedEmpty.conditionalAccess?.policies).toEqual([]);
    expect(syncedEmpty.conditionalAccess?.changedThisPeriod).toBe(0);
  });

  // Review finding (#6034): the admin-detail cap silently truncated a
  // PII-bearing table with no test — the exact silent-truncation failure this
  // report type exists to prevent.
  it('caps the administrator table and DISCLOSES how many were withheld', async () => {
    const signins = Array.from({ length: 502 }, () => signinRow({ userPrincipalName: ADMIN_UPN }));
    queueHappyPath({ users: [userRow({ isAdmin: true, userPrincipalName: ADMIN_UPN })], signins });
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.adminSignins).toHaveLength(500);
    // The totals still reflect every event — the cap is a display limit, and the
    // artifact says so rather than truncating in silence.
    expect(s.signins?.total).toBe(502);
    expect(s.dataGaps?.join(' ')).toMatch(/first 500 of 502/i);
  });

  // Review finding (#6034): byRiskLevel is null for two different reasons and
  // only ONE of them is a licensing statement. Claiming a tenant needs P2 when
  // they simply had a quiet month is a false claim about their subscription.
  it('marks risk unmeasured only when events existed but every value was hidden', async () => {
    queueHappyPath({ signins: [signinRow({ riskLevelAggregated: 'hidden' })] });
    const hidden = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(hidden.coverage?.riskUnmeasured).toBe(true);
    expect(hidden.dataGaps?.join(' ')).toMatch(/P2/);

    queueHappyPath({ signins: [] });
    const quiet = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(quiet.signins?.byRiskLevel).toBeNull();
    expect(quiet.coverage?.riskUnmeasured).toBe(false);
    expect(quiet.dataGaps?.join(' ')).not.toMatch(/P2/);
  });

  it('uses the occurrence period, not now()', async () => {
    queueHappyPath();
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.coverage?.periodStart).toBe('2026-09-01');
    expect(s.coverage?.generatedAt).toBe('2026-09-30T05:18:00.000Z');
  });

  it('reads freshness from last_complete_snapshot_at, exposed as coverage.asOf', async () => {
    queueHappyPath();
    const s = summaryOf(await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP));
    expect(s.coverage?.asOf).toBe('2026-09-30T04:00:00.000Z');
    expect(s.coverage?.lastStatus).toBe('success');
  });

  it('says so, and reads nothing, when M365 tenant sync is disabled entirely', async () => {
    syncEnabledMock.mockReturnValue(false);
    queueHappyPath();
    const res = await generateIdentityAccessReport(ORG_ID, {}, authority(), PERIOD_SEP);
    const s = summaryOf(res);
    expect(s.signins?.total).toBeNull();
    expect(s.dataGaps?.join(' ')).toMatch(/not enabled|disabled/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a missing authority before the first query', async () => {
    queueHappyPath();
    await expect(
      generateIdentityAccessReport(ORG_ID, {}, undefined as never, PERIOD_SEP),
    ).rejects.toThrow(/authority|scope/i);
    expect(db.select).not.toHaveBeenCalled();
  });
});
