/**
 * Identity & Access Review report (#5784 W06) — the service-plan evidence
 * artifact for a month of Microsoft 365 identity activity.
 *
 * WHAT IT CLAIMS. **Interactive** sign-ins only, for the window Breeze actually
 * holds, plus the identity inventory, conditional-access posture and
 * remote-access client presence it already syncs. Non-interactive,
 * service-principal and managed-identity sign-ins are not persisted by W05 and
 * this artifact never implies otherwise.
 *
 * FOUR RULES THIS MODULE EXISTS TO KEEP.
 *
 *  1. RESTRICTED AUTHORITY = REFUSAL, NOT A FILTER (OD-8 = A). M365 identity
 *     data has no site dimension. Serving it to a site-restricted technician
 *     would hand them an org-wide identity view they are not entitled to — a
 *     scope escalation. Every restricted authority gets the empty-but-shaped
 *     result with an explanatory data gap, and NOTHING is read. This differs
 *     from W02/W03/W04 on purpose; do not "fix" it to match them.
 *
 *  2. UNMEASURED IS NOT ZERO, in three distinct ways.
 *       * The tenant needs an Entra ID P1/P2 licence for Graph to release
 *         sign-in logs at all. `AuditLog.Read.All` grants the permission; the
 *         licence grants the data. W05 persists that as a complete, zero-row
 *         success, so every sign-in figure here goes NULL and the artifact
 *         renders a data-gap page rather than an empty table.
 *       * Risk fields come back as Graph's `hidden` sentinel without P2.
 *         `isRiskFieldMeasured` drops them and the section renders unmeasured —
 *         never "no risk detected".
 *       * `m365_users.mfa_registered IS NULL` means UNKNOWN. It is counted into
 *         `mfaUnknown` / `adminsMfaUnknown`, never into "without MFA".
 *
 *  3. COMPLETENESS IS NEVER CLAIMED. Graph retains sign-in logs about 30 days
 *     and Breeze accumulates forward from the first sync, so the first monthly
 *     report after enabling W05 is partial. `coverage.coveredFrom/coveredTo` are
 *     what is actually held and `signinCoverageLine` turns any shortfall into
 *     one printed sentence. Freshness is `last_complete_snapshot_at`, never
 *     `last_success_at` — a partial run succeeds without enumerating the tenant.
 *
 *  4. REMOTE ACCESS IS CLIENT PRESENCE, NOT POLICY. `devices.active_vpns`
 *     records which overlay client is up on a device; the collector header is
 *     explicit that it carries no secrets, peer lists, keys or VPN management
 *     (agent/internal/collectors/vpn.go). The caveat string says so, always.
 *
 * PERSISTED DATA ONLY — no Graph call happens here, so a sweep-triggered run is
 * deterministic and never coupled to Microsoft's availability.
 *
 * PII. This artifact carries user principal names, IP addresses and cities. It
 * reaches a customer only through W01's OD-12 delivery gate, the PDF is never
 * persisted, and the type is deliberately absent from `PORTAL_REPORT_TYPES` and
 * both portal-user allowlists so a customer can never generate one on demand.
 */
import { and, asc, desc, eq, gte, lte, max, min } from 'drizzle-orm';
import type {
  AdminSigninRow,
  CaPolicyRow,
  DormantAccountRow,
  IdentityAccessSummary,
  SigninCoverage,
} from '@breeze/shared';
import {
  LEGACY_AUTH_CLIENT_APPS,
  foreignCountrySignins,
  isRiskFieldMeasured,
  signinCoverageLine,
} from '@breeze/shared';
import { isM365TenantSyncEnabled } from '../config/env';
import { db } from '../db';
import {
  devices,
  m365CaPolicies,
  m365PostureRollups,
  m365SigninEvents,
  m365Users,
  organizations,
} from '../db/schema';
import { identityAccessConfigSchema } from './reportConfigSchemas';
import { loadDomainFreshness } from './m365Sync/summary';
import {
  assertReportExecutionPreflight,
  type EvidenceRunContext,
  type ReportResult,
} from './reportGenerationService';
import type { OrgReportGenerationAuthority } from './siteScope';

/** Cap on the admin sign-in detail table. An admin account with a scripted
 *  client can produce thousands of rows in a month; the artifact states the cap
 *  and the number withheld rather than truncating silently. */
const ADMIN_DETAIL_CAP = 500;

const CLIENT_PRESENCE_CAVEAT =
  'Client presence only: this lists which remote-access client was running on each '
  + 'device at last check-in. No rules, peers, keys or configuration are collected, so '
  + 'nothing here amounts to a review of remote-access policy.';

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function startOfDay(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
}

/** Inclusive period end: a `YYYY-MM-DD` end date means the whole of that day. */
function endOfDay(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T23:59:59.999Z`);
}

/**
 * The window to report on. `EvidenceRunContext` wins whenever it is present —
 * the occurrence's period is the contract, and deriving one from `now()` would
 * make a re-run of a late occurrence quietly report a different month (OD-11).
 * An ad-hoc staff run falls back to the config's date range, then to the
 * trailing 30 days.
 */
function resolveWindow(
  evidence: EvidenceRunContext | undefined,
  rawConfig: Record<string, unknown>,
  generatedAt: string,
): { start: Date; end: Date; periodStart: string; periodEnd: string } {
  if (evidence?.periodStart && evidence?.periodEnd) {
    return {
      start: startOfDay(evidence.periodStart),
      end: endOfDay(evidence.periodEnd),
      periodStart: evidence.periodStart,
      periodEnd: evidence.periodEnd,
    };
  }
  const range = (rawConfig?.dateRange ?? {}) as { start?: string; end?: string };
  const end = range.end ? endOfDay(range.end) : new Date(generatedAt);
  const start = range.start
    ? startOfDay(range.start)
    : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

function countInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The empty-but-shaped result. EVERY measurement is null, because nothing was
 * measured — and a zero here would be read as a finding ("no dormant accounts",
 * "no failed sign-ins") about data that was never looked at.
 */
function emptySummary(
  orgId: string,
  orgName: string | null,
  generatedAt: string,
  coverage: SigninCoverage,
  gaps: string[],
  adminDetail: boolean,
): IdentityAccessSummary {
  return {
    orgId,
    orgName,
    generatedAt,
    coverage: { ...coverage, note: gaps.join(' ') },
    identity: {
      usersTotal: null,
      usersEnabled: null,
      usersDisabled: null,
      admins: null,
      mfaRegistered: null,
      mfaUnknown: null,
      adminsWithoutMfa: null,
      adminsMfaUnknown: null,
    },
    dormant: null,
    signins: {
      total: null,
      distinctUsers: null,
      failures: null,
      failuresByErrorCode: null,
      outsideHomeCountries: null,
      legacyAuth: null,
      conditionalAccessFailures: null,
      byRiskLevel: null,
    },
    // `null` means "the setting was off" (the happy path's own convention,
    // L~576 below). On an empty-data gap page that meaning must be kept
    // distinct from "never measured" — an honest empty array here routes the
    // PDF renderer to its existing "no data was available" branch instead of
    // the false "administrator sign-in detail was switched off" one (#6100).
    adminSignins: adminDetail ? [] : null,
    conditionalAccess: { policies: null, changedThisPeriod: null },
    remoteAccess: null,
    rows: [],
    dataGaps: gaps,
  } satisfies IdentityAccessSummary;
}

function result(
  generatedAt: string,
  summary: IdentityAccessSummary,
  rows: AdminSigninRow[] = [],
): ReportResult {
  return {
    rows: rows as unknown as Record<string, unknown>[],
    rowCount: rows.length,
    generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

type SigninEventRow = {
  signedInAt: Date | string;
  userPrincipalName: string | null;
  appDisplayName: string | null;
  clientAppUsed: string | null;
  ipAddress: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  conditionalAccessStatus: string | null;
  statusErrorCode: number | null;
  riskLevelAggregated: string | null;
};

function toAdminSigninRow(row: SigninEventRow): AdminSigninRow {
  return {
    signedInAt: isoOrNull(row.signedInAt) ?? '',
    userPrincipalName: row.userPrincipalName ?? null,
    appDisplayName: row.appDisplayName ?? null,
    clientAppUsed: row.clientAppUsed ?? null,
    ipAddress: row.ipAddress ?? null,
    locationCity: row.locationCity ?? null,
    locationCountry: row.locationCountry ?? null,
    conditionalAccessStatus: row.conditionalAccessStatus ?? null,
    statusErrorCode: row.statusErrorCode ?? null,
    riskLevelAggregated: row.riskLevelAggregated ?? null,
  };
}

export async function generateIdentityAccessReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: OrgReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const cfg = identityAccessConfigSchema.parse(rawConfig ?? {});
  const generatedAt = evidence?.generatedAt ?? new Date().toISOString();

  assertReportExecutionPreflight(orgId, cfg, authority, 'identity_access_review');

  const window = resolveWindow(evidence, rawConfig ?? {}, generatedAt);
  const baseCoverage: SigninCoverage = {
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    generatedAt,
  };

  // Read on every path, including both gap returns below: this is the org's
  // own display name, not M365 identity data, so it carries none of the scope
  // or "0 sign-ins" risk those returns exist to avoid — and a PII-bearing
  // evidence artifact naming no customer is a distribution hazard on its own
  // (#6100).
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const orgName = orgRow?.name ?? null;

  // --- OD-8 = A: a restricted authority gets NOTHING IDENTITY-SHAPED READ ----
  // Not a filter, a refusal. There is no site dimension on M365 identity data,
  // so "the sites you may see" cannot narrow it; serving it anyway would be a
  // scope escalation. The reason the result is empty is the READER'S SCOPE, so
  // the gap line says that rather than blaming the data.
  if (authority.scope.kind === 'restricted') {
    const gap = 'This report is org-wide: Microsoft 365 identity data has no site '
      + 'dimension, so it cannot be narrowed to the sites this account may see. It is '
      + 'withheld rather than shown in part. Ask an organization-wide account to run it.';
    return result(generatedAt, emptySummary(orgId, orgName, generatedAt, baseCoverage, [gap], cfg.adminDetail));
  }

  // --- The feature flag ------------------------------------------------------
  // `M365_TENANT_SYNC_ENABLED` off means nothing has ever been collected. Say
  // which absence this is, and read nothing identity-shaped: the tables would
  // simply be empty and "0 sign-ins" would be the exact lie this report type
  // exists to prevent.
  if (!isM365TenantSyncEnabled()) {
    const gap = 'Microsoft 365 tenant sync is not enabled for this deployment, so no '
      + 'identity or sign-in data has been collected. This is a configuration gap, not '
      + 'a statement about sign-in activity.';
    return result(generatedAt, emptySummary(orgId, orgName, generatedAt, baseCoverage, [gap], cfg.adminDetail));
  }

  const gaps: string[] = [];

  const freshness = await loadDomainFreshness(orgId, ['signin_events', 'users', 'ca_policies']);
  const signinFreshness = freshness.signin_events;

  // --- 1. Identity inventory --------------------------------------------------
  // The rollup is read for its "unknown" counters; the live user rows are the
  // authority for everything the report itemises. Where both exist the rollup is
  // only a cross-check — the live rows are what the dormant list comes from, so
  // deriving the totals from anywhere else would let the two disagree on the page.
  const [rollup] = await db
    .select({
      usersTotal: m365PostureRollups.usersTotal,
      usersEnabled: m365PostureRollups.usersEnabled,
      usersMfaRegistered: m365PostureRollups.usersMfaRegistered,
      usersMfaUnknown: m365PostureRollups.usersMfaUnknown,
      usersAdmin: m365PostureRollups.usersAdmin,
      adminsWithoutMfa: m365PostureRollups.adminsWithoutMfa,
      adminsMfaUnknown: m365PostureRollups.adminsMfaUnknown,
    })
    .from(m365PostureRollups)
    .where(eq(m365PostureRollups.orgId, orgId))
    .orderBy(desc(m365PostureRollups.rollupDate))
    .limit(1);

  const userRows = await db
    .select({
      userPrincipalName: m365Users.userPrincipalName,
      displayName: m365Users.displayName,
      accountEnabled: m365Users.accountEnabled,
      isAdmin: m365Users.isAdmin,
      mfaRegistered: m365Users.mfaRegistered,
      lastSuccessfulSignInAt: m365Users.lastSuccessfulSignInAt,
      isStale: m365Users.isStale,
    })
    .from(m365Users)
    .where(and(eq(m365Users.orgId, orgId), eq(m365Users.isStale, false)));

  // Captured before the branch below: narrowing `identityMeasured` would make
  // `rollup` `never` in the unmeasured arm, where it is exactly what we want.
  const rollupMfaUnknown = countInt(rollup?.usersMfaUnknown);
  const identityMeasured = userRows.length > 0 || rollup !== undefined;
  const admins = userRows.filter((u) => u.isAdmin === true);
  const identity = identityMeasured
    ? {
      usersTotal: userRows.length,
      usersEnabled: userRows.filter((u) => u.accountEnabled === true).length,
      usersDisabled: userRows.filter((u) => u.accountEnabled === false).length,
      admins: admins.length,
      mfaRegistered: userRows.filter((u) => u.mfaRegistered === true).length,
      // NULL is UNKNOWN. Counted here and NEVER folded into "without MFA".
      mfaUnknown: userRows.filter((u) => u.mfaRegistered === null || u.mfaRegistered === undefined).length,
      adminsWithoutMfa: admins.filter((u) => u.mfaRegistered === false).length,
      adminsMfaUnknown: admins.filter((u) => u.mfaRegistered === null || u.mfaRegistered === undefined).length,
    }
    : {
      usersTotal: null,
      usersEnabled: null,
      usersDisabled: null,
      admins: null,
      mfaRegistered: null,
      mfaUnknown: rollupMfaUnknown,
      adminsWithoutMfa: null,
      adminsMfaUnknown: null,
    };

  if (!identityMeasured) {
    gaps.push('No Microsoft 365 user inventory has been synced for this organization, so '
      + 'the identity figures below are unmeasured rather than zero.');
  }

  // --- 2. Dormant accounts ----------------------------------------------------
  // ENABLED accounts only: a disabled account that has not signed in is expected,
  // not a finding. A NULL last sign-in means NEVER OBSERVED and is listed first —
  // it is not the same fact as "long ago" and the row keeps the null so the
  // renderer can say which.
  const dormantCutoff = new Date(window.end.getTime() - cfg.dormantDays * 24 * 60 * 60 * 1000);
  const dormantRows: DormantAccountRow[] = identityMeasured
    ? userRows
      .filter((u) => u.accountEnabled !== false)
      .filter((u) => {
        const last = u.lastSuccessfulSignInAt ? new Date(u.lastSuccessfulSignInAt).getTime() : null;
        return last === null || last < dormantCutoff.getTime();
      })
      .map((u) => ({
        userPrincipalName: u.userPrincipalName ?? null,
        displayName: u.displayName ?? null,
        lastSuccessfulSignInAt: isoOrNull(u.lastSuccessfulSignInAt),
        isAdmin: u.isAdmin === true,
        mfaRegistered: u.mfaRegistered ?? null,
      }))
      .sort((a, b) => {
        if (a.lastSuccessfulSignInAt === b.lastSuccessfulSignInAt) return 0;
        if (a.lastSuccessfulSignInAt === null) return -1;
        if (b.lastSuccessfulSignInAt === null) return 1;
        return a.lastSuccessfulSignInAt < b.lastSuccessfulSignInAt ? -1 : 1;
      })
    : [];

  // --- 3. Sign-in activity for the period ------------------------------------
  // Skipped entirely when the tenant is unlicensed: W05 records that as a
  // complete, zero-update success, so the table would be empty and would read as
  // "nobody signed in" for a tenant Graph never released a single record for.
  const signinEventRows: SigninEventRow[] = signinFreshness.unlicensed
    ? []
    : (await db
      .select({
        signedInAt: m365SigninEvents.signedInAt,
        userPrincipalName: m365SigninEvents.userPrincipalName,
        appDisplayName: m365SigninEvents.appDisplayName,
        clientAppUsed: m365SigninEvents.clientAppUsed,
        ipAddress: m365SigninEvents.ipAddress,
        locationCity: m365SigninEvents.locationCity,
        locationCountry: m365SigninEvents.locationCountry,
        conditionalAccessStatus: m365SigninEvents.conditionalAccessStatus,
        statusErrorCode: m365SigninEvents.statusErrorCode,
        riskLevelAggregated: m365SigninEvents.riskLevelAggregated,
      })
      .from(m365SigninEvents)
      .where(and(
        eq(m365SigninEvents.orgId, orgId),
        gte(m365SigninEvents.signedInAt, window.start),
        lte(m365SigninEvents.signedInAt, window.end),
      ))
      .orderBy(asc(m365SigninEvents.signedInAt))) as SigninEventRow[];

  // The window Breeze ACTUALLY holds, over the whole table rather than the
  // period: an org whose collection began mid-period has events after the
  // period's start but not from it, and only the unbounded MIN/MAX can say so.
  const [held] = signinFreshness.unlicensed
    ? []
    : await db
      .select({ earliest: min(m365SigninEvents.signedInAt), latest: max(m365SigninEvents.signedInAt) })
      .from(m365SigninEvents)
      .where(eq(m365SigninEvents.orgId, orgId));

  const failures = signinEventRows.filter(
    (r) => typeof r.statusErrorCode === 'number' && r.statusErrorCode !== 0,
  );
  const failuresByErrorCode: Record<string, number> = {};
  for (const row of failures) {
    const key = String(row.statusErrorCode);
    failuresByErrorCode[key] = (failuresByErrorCode[key] ?? 0) + 1;
  }
  const legacyAuth: Record<string, number> = {};
  for (const row of signinEventRows) {
    if (row.clientAppUsed && LEGACY_AUTH_CLIENT_APPS.has(row.clientAppUsed)) {
      legacyAuth[row.clientAppUsed] = (legacyAuth[row.clientAppUsed] ?? 0) + 1;
    }
  }
  const byRiskLevel: Record<string, number> = {};
  for (const row of signinEventRows) {
    if (!isRiskFieldMeasured(row.riskLevelAggregated)) continue;
    const key = row.riskLevelAggregated!.trim();
    byRiskLevel[key] = (byRiskLevel[key] ?? 0) + 1;
  }

  const signins = signinFreshness.unlicensed
    ? {
      total: null,
      distinctUsers: null,
      failures: null,
      failuresByErrorCode: null,
      outsideHomeCountries: null,
      legacyAuth: null,
      conditionalAccessFailures: null,
      byRiskLevel: null,
    }
    : {
      total: signinEventRows.length,
      distinctUsers: new Set(
        signinEventRows.map((r) => r.userPrincipalName).filter((v): v is string => Boolean(v)),
      ).size,
      failures: failures.length,
      failuresByErrorCode,
      outsideHomeCountries: foreignCountrySignins(signinEventRows, cfg.homeCountries),
      legacyAuth,
      // NULL, not {}, when every value came back as Graph's `hidden` sentinel:
      // an empty object renders as "no risk found", which is a claim about a
      // tenant that was never assessed.
      conditionalAccessFailures: signinEventRows.filter((r) => r.conditionalAccessStatus === 'failure').length,
      byRiskLevel: Object.keys(byRiskLevel).length > 0 ? byRiskLevel : null,
    };

  // --- 4. Admin sign-in detail — the section an auditor reads first -----------
  const adminUpns = new Set(
    admins.map((u) => u.userPrincipalName?.toLowerCase()).filter((v): v is string => Boolean(v)),
  );
  const adminEvents = signinFreshness.unlicensed || !cfg.adminDetail
    ? []
    : signinEventRows.filter(
      (r) => r.userPrincipalName != null && adminUpns.has(r.userPrincipalName.toLowerCase()),
    );
  const adminSigninRows = adminEvents.slice(0, ADMIN_DETAIL_CAP).map(toAdminSigninRow);
  if (cfg.adminDetail && adminEvents.length > ADMIN_DETAIL_CAP) {
    gaps.push(`The administrator sign-in table lists the first ${ADMIN_DETAIL_CAP} of `
      + `${adminEvents.length} interactive administrator sign-ins in this period; the rest `
      + 'are counted in the totals above but not itemised.');
  }

  // --- 5. Conditional access posture -----------------------------------------
  const caRows = await db
    .select({
      displayName: m365CaPolicies.displayName,
      state: m365CaPolicies.state,
      lastChangedAt: m365CaPolicies.lastChangedAt,
      isStale: m365CaPolicies.isStale,
    })
    .from(m365CaPolicies)
    .where(eq(m365CaPolicies.orgId, orgId))
    .orderBy(asc(m365CaPolicies.displayName));

  const caPolicies: CaPolicyRow[] = caRows.map((row) => {
    const changed = row.lastChangedAt ? new Date(row.lastChangedAt) : null;
    return {
      displayName: row.displayName ?? null,
      state: row.state ?? null,
      changedThisPeriod: changed !== null
        && changed.getTime() >= window.start.getTime()
        && changed.getTime() <= window.end.getTime(),
      isStale: row.isStale === true,
    };
  });
  const caMeasured = caRows.length > 0 || freshness.ca_policies.asOf !== null;

  // --- 6. Remote access — CLIENT PRESENCE, never policy -----------------------
  // `devices.active_vpns` is NULL until the VPN collector has run on a device.
  // An org with no devices, or whose devices have never reported, has not been
  // MEASURED — and `{}` would print as "None observed at last check-in", which
  // reads as "we looked and found nothing". Same gate as identity and CA above.
  const deviceRows = await db
    .select({ activeVpns: devices.activeVpns })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  const vpnReportingDevices = deviceRows.filter((row) => Array.isArray(row.activeVpns));
  const remoteAccessMeasured = vpnReportingDevices.length > 0;
  const byProvider: Record<string, number> = {};
  for (const row of vpnReportingDevices) {
    for (const vpn of row.activeVpns ?? []) {
      if (vpn?.active !== true) continue;
      const provider = vpn.provider ?? 'generic';
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    }
  }
  // A fleet where only SOME devices have reported would otherwise under-count
  // silently, so the shortfall is disclosed rather than folded into the total.
  const vpnSilentDevices = deviceRows.length - vpnReportingDevices.length;

  // --- 7. Coverage and the printed limits ------------------------------------
  // `byRiskLevel` is null for TWO different reasons and the artifact must not
  // conflate them: either every value came back as Graph's `hidden` sentinel
  // (the tenant genuinely has no Entra ID P2 — say so), or there were simply no
  // sign-ins in the period to assess (a quiet, possibly fully-licensed tenant —
  // telling them they need P2 would be a false claim about their licensing on a
  // customer-facing document). Only the first case is a licensing statement.
  const riskUnmeasured = signins.byRiskLevel === null
    && !signinFreshness.unlicensed
    && signinEventRows.length > 0;

  const coverage: SigninCoverage = {
    ...baseCoverage,
    coveredFrom: isoOrNull(held?.earliest as Date | string | null | undefined),
    coveredTo: isoOrNull(held?.latest as Date | string | null | undefined),
    // last_complete_snapshot_at, NEVER last_success_at.
    asOf: signinFreshness.asOf,
    lastStatus: signinFreshness.lastStatus,
    unlicensed: signinFreshness.unlicensed,
    riskUnmeasured,
  };
  const coverageNote = signinCoverageLine(coverage);
  if (coverageNote) gaps.unshift(coverageNote);
  if (riskUnmeasured) {
    gaps.push('Microsoft returned no risk assessment for these sign-ins. Sign-in risk '
      + 'requires an Entra ID P2 licence; this section is unmeasured, not a finding that '
      + 'no risk was detected.');
  }
  if (!remoteAccessMeasured) {
    gaps.push('No device has reported which remote-access client is running, so remote-access '
      + 'client presence is unmeasured for this organization. It is not a finding that no '
      + 'remote-access tooling is in use.');
  } else if (vpnSilentDevices > 0) {
    gaps.push(`${vpnSilentDevices} device(s) have never reported remote-access client presence, `
      + 'so the figures below cover only the devices that have.');
  }
  coverage.note = coverageNote;

  const summary: IdentityAccessSummary = {
    orgId,
    orgName,
    generatedAt,
    coverage,
    identity,
    dormant: identityMeasured ? { thresholdDays: cfg.dormantDays, rows: dormantRows } : null,
    signins,
    adminSignins: cfg.adminDetail ? adminSigninRows : null,
    conditionalAccess: {
      policies: caMeasured ? caPolicies : null,
      changedThisPeriod: caMeasured ? caPolicies.filter((p) => p.changedThisPeriod).length : null,
    },
    remoteAccess: remoteAccessMeasured ? { byProvider, caveat: CLIENT_PRESENCE_CAVEAT } : null,
    rows: cfg.adminDetail ? adminSigninRows : [],
    dataGaps: gaps,
  } satisfies IdentityAccessSummary;

  return result(generatedAt, summary, cfg.adminDetail ? adminSigninRows : []);
}
