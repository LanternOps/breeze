/**
 * Report schedule worker.
 *
 * Executes saved reports whose `schedule` is daily/weekly/monthly. Until this
 * worker existed the builder let users pick a cadence (persisted on
 * `reports.schedule` + `config.schedule.{time,day,date}`) but nothing ever ran
 * them — schedules were silently dead.
 *
 * - `check-schedules` repeats every 5 minutes, computes each report's most
 *   recent scheduled occurrence in the org's timezone (org -> partner -> UTC
 *   chain, same resolution the rest of the platform uses), and enqueues a run
 *   when `lastGeneratedAt` predates that occurrence.
 * - `run-scheduled-report` mirrors the on-demand POST /reports/:id/generate
 *   path: insert a report_runs row, generateReport, store the snapshot. When
 *   `config.emailRecipients` is set, recipients get an email with the branded
 *   PDF attached for PDF-format reports (rendered server-side via
 *   @breeze/shared/reportPdf) or a CSV attachment for tabular formats — either
 *   way, plus an in-app link.
 * - Without Redis the check falls back to inline processing, matching the
 *   other queue workers.
 */

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import * as dbModule from '../db';
import { breezeRole } from '../config/env';
import {
  contacts,
  organizations,
  partners,
  reportRuns,
  reportScheduleRecipients,
  reports,
} from '../db/schema';
import {
  assertReportExecutionPreflight,
  generateReport,
  previousBaselineFor,
  UnsupportedReportScopeError,
  type ReportResult,
} from '../services/reportGenerationService';
import { reportScopeFromAuthority } from '../services/reportScope';
import { reportTypeDef } from '../services/reportRegistry';
import { emailReportFailure, emailReportRun } from '../services/reportDelivery';
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import {
  lastOccurrenceKey,
  isDue,
  type ScheduleCadence,
  type ScheduleConfig,
} from '@breeze/shared';
import {
  loadReportBrandingForOrg,
  loadReportBrandingForPartner,
} from '../services/reportBranding';
import {
  resolveOrgTimezone,
  resolvePartnerTimezone,
  resolveTimezoneFromRows,
} from '../services/portal/timezone';
import { captureException } from '../services/sentry';
import { dateFromOffsetlessDbTimestamp } from '../utils/offsetlessTimestamp';
import { attachWorkerObservability } from './workerObservability';
import {
  decodeSiteScope,
  intersectSiteScopes,
  partnerWideScope,
  persistedSiteScopeValues,
  reportOwnerOf,
  resolveLivePartnerReportAuthority,
  resolveLiveReportAuthority,
  resolveLiveReportTypePermissions,
  siteScopeFingerprint,
  type LiveReportAuthorityResult,
  type PersistedSiteScopeColumns,
  type ReportExecutionAuthority,
  type ReportOwner,
} from '../services/siteScope';

// Re-exported so the occurrence-math tests colocated with this worker keep
// importing from here; the implementation lives in @breeze/shared so the web
// can compute "next run" from the same math.
export { lastOccurrenceKey, isDue, wallClockIn } from '@breeze/shared';
export type { ScheduleCadence, ScheduleConfig } from '@breeze/shared';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const REPORT_SCHEDULE_QUEUE = 'report-schedules';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Attempts per `run-scheduled-report` job before the occurrence is given up on. */
const RUN_JOB_ATTEMPTS = 3;

interface CheckSchedulesJobData {
  type: 'check-schedules';
}

interface RunScheduledReportJobData {
  type: 'run-scheduled-report';
  reportId: string;
  /** Wall-clock occurrence key the run was enqueued for (dedupe + audit). */
  occurrenceKey: number;
}

type ReportScheduleJobData = CheckSchedulesJobData | RunScheduledReportJobData;

let reportScheduleQueue: Queue<ReportScheduleJobData> | null = null;
let reportScheduleWorker: Worker<ReportScheduleJobData> | null = null;

// ─── Due-report discovery ────────────────────────────────────────────────────

type DueCandidate = {
  id: string;
  schedule: ScheduleCadence;
  lastGeneratedAt: Date | null;
  config: Record<string, unknown>;
  timeZone: string;
};

/**
 * Whether a schedule's `lastGeneratedAt` is older than the occurrence keyed by
 * `occurrenceKey`, exported as a pure seam so the offsetless-timestamp
 * correction below can be asserted directly under a pinned non-UTC TZ
 * (#4059 gap 2 / `vitest.config.tz.ts`) without a database.
 */
export function isReportOccurrenceDue(
  lastGeneratedAt: Date | null,
  occurrenceKey: number,
  timeZone: string,
): boolean {
  // `reports.last_generated_at` is `timestamp(...)` with no `withTimezone`, so
  // the driver hands us the UTC wall clock re-read as this process's local
  // time (#4059 gap 2 — see utils/offsetlessTimestamp.ts). `isDue` then reads
  // wall-clock parts off that Date in the org's zone, so without the
  // correction the comparison is wrong by the API host's offset: east of UTC
  // an occurrence that already ran re-fires (duplicate report delivery), west
  // of UTC one that has not run is suppressed (silently missed report).
  // The RAW value still flows to `buildOccurrenceClaimCas` — that comparison
  // happens in SQL against the column itself and must not be corrected.
  return isDue(
    lastGeneratedAt ? dateFromOffsetlessDbTimestamp(lastGeneratedAt) : null,
    occurrenceKey,
    timeZone,
  );
}

function scheduleConfigOf(config: Record<string, unknown>): ScheduleConfig {
  const raw = config.schedule;
  return raw && typeof raw === 'object' ? (raw as ScheduleConfig) : {};
}

/**
 * P2-3 (#4190) — report types this worker must never poll for or execute.
 *
 * A weekly AI narrative definition lives in `reports` with `schedule =
 * 'weekly'`, so it matches the polling predicate on shape alone; its
 * occurrences belong to the AGENT scheduler, and its artifact is stored by the
 * run's own transaction rather than generated.
 *
 * Excluding it here does a second job that is easy to miss: it keeps those rows
 * out of the "requires scope reauthorization" warning count below. A system
 * definition has `execution_scope_user_id IS NULL` by construction, so it fails
 * `completeExecutableScope` forever — and without this exclusion the operator
 * signal would climb by one per org, per narrative schedule, pointing at rows
 * nobody can or should reauthorize.
 *
 * Fleet Designer W01 (#5651) added `ai_fleet_design`. Its definition's own
 * `schedule` column is `'one_time'`, so it is already excluded from the
 * `pollable` predicate below by the `ne(reports.schedule, 'one_time')` clause
 * alone — but it needs to be in THIS list too, for the same "requires scope
 * reauthorization" warning-count exclusion the narrative needed, and for the
 * defense-in-depth check at the execute-path call site below
 * (`WORKER_EXCLUDED_REPORT_TYPES.includes(report.type)`).
 *
 * Exported for `reportScheduleWorker.contract.test.ts` (#4248 W03), which pins
 * both enforcement sites and the list's parity with the route-side
 * `INTERNAL_REPORT_TYPES` — the recipient writers refuse on that set, so a
 * type in one list but not the other is a definition that is either never
 * delivered or delivered twice.
 */
export const WORKER_EXCLUDED_REPORT_TYPES = ['ai_org_narrative', 'ai_fleet_design'] as const;

/**
 * A definition this worker can reauthorize and run: a complete v1 envelope
 * with an acting user, whose kind agrees with the row's owner axis. The
 * per-kind disjunction carries the owner guard (#3198 W01, spec §3.1a): org
 * kinds need `org_id`, `partner_wide` needs `partner_id`; the acting-user,
 * fingerprint and capture-time requirements stay top-level conjuncts so no
 * kind can escape them. Exported for its compiled-SQL test.
 */
export function completeExecutableScopePredicate() {
  return and(
    eq(reports.executionScopeVersion, 1),
    inArray(reports.executionScopeKind, ['unrestricted', 'restricted', 'partner_wide']),
    isNotNull(reports.executionScopeUserId),
    isNotNull(reports.executionScopeFingerprint),
    isNotNull(reports.executionScopeCapturedAt),
    or(
      and(
        eq(reports.executionScopeKind, 'unrestricted'),
        isNull(reports.executionScopeSiteIds),
        isNotNull(reports.orgId),
      ),
      and(
        eq(reports.executionScopeKind, 'restricted'),
        isNotNull(reports.executionScopeSiteIds),
        isNotNull(reports.orgId),
      ),
      and(
        eq(reports.executionScopeKind, 'partner_wide'),
        isNull(reports.executionScopeSiteIds),
        isNotNull(reports.partnerId),
      ),
    ),
  )!;
}

export async function findDueReports(
  now: Date,
): Promise<Array<{ id: string; occurrenceKey: number; lastGeneratedAt: Date | null }>> {
  // Applied to BOTH statements below — see WORKER_EXCLUDED_REPORT_TYPES.
  const pollable = and(
    ne(reports.schedule, 'one_time'),
    notInArray(reports.type, [...WORKER_EXCLUDED_REPORT_TYPES]),
  )!;
  const completeExecutableScope = completeExecutableScopePredicate();
  // Timezone chain: org -> partner -> UTC. A partner-owned row (#3198 W01) has
  // no org, so the org join is OUTER, and the partner joined is the row's own
  // partner, else its org's partner. Exactly one of the two is set
  // (reports_one_owner_chk), so the coalesce never has to choose; for an
  // org-owned row it reduces to the previous `organizations.partner_id` join.
  const rows = await db
    .select({
      id: reports.id,
      schedule: reports.schedule,
      lastGeneratedAt: reports.lastGeneratedAt,
      config: reports.config,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(reports)
    .leftJoin(organizations, eq(reports.orgId, organizations.id))
    .leftJoin(
      partners,
      eq(partners.id, sql`coalesce(${reports.partnerId}, ${organizations.partnerId})`),
    )
    .where(and(pollable, completeExecutableScope));

  const [skipped] = await db
    .select({ count: sql<number>`count(*)` })
    .from(reports)
    .where(and(pollable, not(completeExecutableScope)));
  const skippedCount = Number(skipped?.count ?? 0);
  if (skippedCount > 0) {
    console.warn(
      '[ReportScheduleWorker] Scheduled reports require scope reauthorization',
      { count: skippedCount },
    );
  }

  const due: Array<{ id: string; occurrenceKey: number; lastGeneratedAt: Date | null }> = [];
  for (const row of rows) {
    const candidate: DueCandidate = {
      id: row.id,
      schedule: row.schedule as ScheduleCadence,
      lastGeneratedAt: row.lastGeneratedAt,
      config: (row.config ?? {}) as Record<string, unknown>,
      timeZone: resolveTimezoneFromRows(row.orgSettings, row.partnerTimezone, row.partnerSettings),
    };
    const key = lastOccurrenceKey(now, candidate.schedule, scheduleConfigOf(candidate.config), candidate.timeZone);
    if (isReportOccurrenceDue(candidate.lastGeneratedAt, key, candidate.timeZone)) {
      due.push({ id: candidate.id, occurrenceKey: key, lastGeneratedAt: candidate.lastGeneratedAt });
    }
  }
  return due;
}

// ─── Occurrence claim (CAS) ──────────────────────────────────────────────────

/**
 * The inline (Redis-less) path's cross-tick winner predicate, extracted so
 * its COMPILED SQL can be asserted directly (see `reportScheduleWorker.claimSql.test.ts`
 * — a mocked-drizzle `.where(...)` assertion can only substring-match column
 * names, which cannot tell `eq` from `isNull` or notice a dropped id
 * predicate; either mutation would let two overlapping 5-minute ticks
 * double-generate the same occurrence). `observedLastGeneratedAt` is the value
 * `findDueReports` read when it decided the report was due — the CAS only
 * claims the row if nothing has changed it since.
 */
export function buildOccurrenceClaimCas(reportId: string, observedLastGeneratedAt: Date | null) {
  return and(
    eq(reports.id, reportId),
    observedLastGeneratedAt === null
      ? isNull(reports.lastGeneratedAt)
      : eq(reports.lastGeneratedAt, observedLastGeneratedAt),
  );
}

/**
 * Atomically claims a due occurrence for inline execution: stamps
 * `lastGeneratedAt` now, but ONLY if it still matches what was observed when
 * the occurrence was found due. Returns whether the claim won — a lost race
 * (another overlapping check already claimed it) returns false and the caller
 * skips the report rather than generating it twice.
 */
async function claimReportOccurrence(reportId: string, observedLastGeneratedAt: Date | null): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .update(reports)
    .set({ lastGeneratedAt: now, updatedAt: now })
    .where(buildOccurrenceClaimCas(reportId, observedLastGeneratedAt))
    .returning({ id: reports.id });
  return claimed.length > 0;
}

// ─── Execution ───────────────────────────────────────────────────────────────

function validEmail(value: unknown): value is string {
  return typeof value === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export async function resolveScheduledReportRecipients(args: {
  reportId: string;
  /** NULL for a partner-owned definition (#3198 W01): contact recipients are
   *  org-scoped rows, so only `config.emailRecipients` applies (spec §3.1a). */
  orgId: string | null;
  config: Record<string, unknown>;
}): Promise<string[]> {
  const contactRows = args.orgId === null ? [] : await db
    .select({
      contactId: contacts.id,
      email: contacts.email,
    })
    .from(reportScheduleRecipients)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, reportScheduleRecipients.contactId),
        eq(contacts.orgId, reportScheduleRecipients.orgId),
      ),
    )
    .where(and(
      eq(reportScheduleRecipients.reportId, args.reportId),
      eq(reportScheduleRecipients.orgId, args.orgId),
      eq(contacts.orgId, args.orgId),
    ));

  const candidates: string[] = [];
  for (const row of contactRows) {
    if (!row.email) {
      console.warn(
        '[ReportScheduleWorker] Recipient contact has no email; skipping',
        {
          reportId: args.reportId,
          contactId: row.contactId,
        },
      );
      continue;
    }
    if (validEmail(row.email)) candidates.push(row.email.trim());
  }

  const legacy = args.config.emailRecipients;
  if (Array.isArray(legacy)) {
    candidates.push(
      ...legacy.filter(validEmail).map((email) => email.trim()),
    );
  }

  const deduped = new Map<string, string>();
  for (const email of candidates) {
    const key = email.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, email);
  }

  const resolved = [...deduped.values()];
  if (resolved.length > 50) {
    console.warn(
      '[ReportScheduleWorker] Recipient union exceeds 50; truncating',
      {
        reportId: args.reportId,
        requested: resolved.length,
      },
    );
  }
  return resolved.slice(0, 50);
}

/** One-line trend summary for the email body — "Posture score 79 — up from
 * 74 last run." — built from the same `result.summary`/`result.previous`
 * snapshot the PDF scorecard reads, so the two never disagree. */
function trendLineOf(result: ReportResult): string | null {
  const s = result.summary as Record<string, unknown> | undefined;
  const prev = result.previous?.summary as Record<string, unknown> | undefined;
  const score = typeof s?.postureScore === 'number' ? (s.postureScore as number) : null;
  if (score != null) {
    const prevScore = typeof prev?.postureScore === 'number' ? (prev.postureScore as number) : null;
    if (prevScore != null && prevScore !== score) {
      return `Posture score ${score} — ${score > prevScore ? 'up' : 'down'} from ${prevScore} last run.`;
    }
    return `Posture score ${score}.`;
  }
  const health = (s?.devices as { healthPercentage?: unknown } | undefined)?.healthPercentage;
  if (typeof health === 'number') {
    const prevHealth = (prev?.devices as { healthPercentage?: unknown } | undefined)?.healthPercentage;
    if (typeof prevHealth === 'number' && prevHealth !== health) {
      return `Fleet health ${health}% — ${health > prevHealth ? 'up' : 'down'} from ${prevHealth}% last run.`;
    }
    return `Fleet health ${health}%.`;
  }
  return null;
}

/**
 * The owner-dependent half of email delivery: which zone the email renders
 * in, whose branding it carries, and which partner lane sends it. An org
 * owner keeps the org -> partner chain and its org's partner lane; a partner
 * owner (#3198 W01) uses its own partner row for all three — there is no org
 * to read. Exported for the owner-axis tests.
 */
export async function resolveScheduledDeliveryContext(owner: ReportOwner): Promise<{
  timeZone: string;
  branding: Awaited<ReturnType<typeof loadReportBrandingForOrg>>;
  partnerId: string | null;
}> {
  const unbranded = (err: unknown) => {
    console.error('[ReportScheduleWorker] Branding load failed; sending unbranded:', err);
    return { name: null, logoDataUrl: null, logoAspect: null };
  };

  if (owner.partnerId !== undefined) {
    const timeZone = await resolvePartnerTimezone(owner.partnerId);
    const branding = await loadReportBrandingForPartner(owner.partnerId).catch(unbranded);
    return { timeZone, branding, partnerId: owner.partnerId };
  }

  const timeZone = await resolveOrgTimezone(owner.orgId);
  const branding = await loadReportBrandingForOrg(owner.orgId).catch(unbranded);
  // The scheduled report IS a customer deliverable — partner lane, `general`
  // stream (spec §8.2). Every job in this worker runs inside
  // runWithSystemDbAccess, so this is a plain system-context read of an org
  // row the job already owns.
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, owner.orgId))
    .limit(1);
  return { timeZone, branding, partnerId: orgRow?.partnerId ?? null };
}

export async function processRunScheduledReport(
  data: RunScheduledReportJobData,
  opts: { finalAttempt?: boolean; occurrenceClaimed?: boolean } = {},
): Promise<void> {
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, data.reportId), ne(reports.schedule, 'one_time')))
    .limit(1);
  if (!report) return; // deleted or switched to one_time since enqueue

  // P2-3 (#4190) — a job already on the queue when the type exclusion in
  // `findDueReports` shipped, or one forced in by hand. An EARLY RETURN with no
  // run row, deliberately unlike the `deny()` paths below: a failed
  // `report_runs` row would render in the org's report history under the
  // narrative definition, beside the real weekly artifacts, claiming the weekly
  // narrative failed. It did not — this worker simply is not its owner.
  if ((WORKER_EXCLUDED_REPORT_TYPES as readonly string[]).includes(report.type)) {
    console.warn(
      '[ReportScheduleWorker] Skipping a report type owned by the agent scheduler',
      { reportId: report.id, orgId: report.orgId, type: report.type },
    );
    return;
  }

  const config = (report.config ?? {}) as Record<string, unknown>;

  // Set once the owner axis is resolved (below); a deny before that point
  // cannot know which envelope the row would need.
  let knownOwner: ReportOwner | undefined;

  /**
   * #3198 W02 (addendum B3). A PARTNER-owned run is only ever listed / read by
   * id when it carries a complete partner_wide envelope (partnerWideRowPredicate
   * and decodeSiteScope reject the all-NULL shape for a partner owner), so a
   * bare failed row would be invisible to the partner admins who need to see
   * why the schedule stopped. Stamp the owner's partner_wide scope with the
   * definition's execution user — the principal the refusal is about. The
   * report_runs_execution_scope_shape_chk partner_wide arm requires a user id,
   * so a deny before the owner is known, or for a definition with no execution
   * user, stays envelope-less (and invisible to partner callers; it is still
   * in the table for operators). Org-owned denies keep the all-NULL shape the
   * org-axis predicates already admit.
   */
  const partnerDenyEnvelope = (
    requestedByKind: 'user' | 'system' | 'portal_user' | null,
  ): PersistedSiteScopeColumns | Record<string, never> => {
    if (
      knownOwner?.partnerId === undefined
      || requestedByKind !== 'user'
      || !report.executionScopeUserId
    ) {
      return {};
    }
    try {
      const scope = partnerWideScope(knownOwner.partnerId);
      return persistedSiteScopeValues({
        principalKind: 'user',
        scope,
        principalUserId: report.executionScopeUserId,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      });
    } catch (err) {
      // Never lose the refusal itself over its visibility envelope.
      reportScopeFailure('deny_envelope', err);
      return {};
    }
  };

  const deny = async (
    reason: string,
    requestedByKind:
      | 'user'
      | 'system'
      | 'portal_user'
      | null = report.executionScopePrincipalKind === 'system'
        ? 'system'
        : report.executionScopeUserId
          ? 'user'
          : null,
  ): Promise<void> => {
    await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'failed',
        completedAt: new Date(),
        errorMessage: reason,
        requestedByKind,
        requestedByUserId:
          requestedByKind === 'user' ? report.executionScopeUserId : null,
        requestedByPortalUserId: null,
        ...partnerDenyEnvelope(requestedByKind),
      })
      .returning();
  };

  // #3198 W02 (B4): the owner/decode/live-resolve catches below fail closed as
  // 'scope_unverifiable', but the cause (a corrupt row, a DB outage) must be
  // visible - otherwise it reads as an ordinary permission refusal.
  const reportScopeFailure = (stage: string, err: unknown): void => {
    console.error('[ReportScheduleWorker] Execution scope could not be verified', {
      reportId: report.id,
      stage,
      err,
    });
    captureException(err);
  };

  // P2-3 (#4190) — defence in depth. A system-authored definition (the weekly
  // AI org narrative) has no acting user, so there is nobody for this worker to
  // reauthorize against; it is owned by the agent scheduler, not the report
  // scheduler. findDueReports already skips it (its executable-scope predicate
  // requires execution_scope_user_id NOT NULL) and A7 adds the type exclusion —
  // this refuses it even if a caller forces the job in directly, BEFORE any
  // scope decode or authority resolution can invent a principal.
  const definitionPrincipalKind = report.executionScopePrincipalKind ?? null;
  if (definitionPrincipalKind !== null && definitionPrincipalKind !== 'user') {
    console.warn(
      '[ReportScheduleWorker] Refusing a non-user-principal report definition',
      {
        reportId: report.id,
        orgId: report.orgId,
        principalKind: definitionPrincipalKind,
      },
    );
    if (definitionPrincipalKind === 'system') {
      await deny('system_principal_definition');
    } else if (definitionPrincipalKind === 'portal_user') {
      await deny('portal_user_principal_definition', 'portal_user');
    }
    return;
  }

  // #3198 W01 — the owner axis decides the decode, the live resolver, the
  // preflight, generation and delivery below. A row with neither (or both)
  // axes is corrupt, not runnable.
  let owner: ReportOwner;
  try {
    owner = reportOwnerOf(report);
  } catch (err) {
    reportScopeFailure('owner', err);
    await deny('scope_unverifiable');
    return;
  }
  knownOwner = owner;

  let persistedScope;
  try {
    persistedScope = decodeSiteScope(
      report as unknown as PersistedSiteScopeColumns,
      owner,
    );
  } catch (err) {
    reportScopeFailure('decode', err);
    await deny('scope_unverifiable');
    return;
  }
  if (persistedScope.kind === 'legacy_unscoped') {
    await deny('scope_legacy_unscoped');
    return;
  }

  if (!report.executionScopeUserId) {
    await deny('scope_unverifiable');
    return;
  }

  let liveResult: LiveReportAuthorityResult;
  try {
    liveResult = owner.partnerId !== undefined
      ? await resolveLivePartnerReportAuthority(
          report.executionScopeUserId,
          owner.partnerId,
          'read',
        )
      : await resolveLiveReportAuthority(
          report.executionScopeUserId,
          owner.orgId,
          'read',
        );
  } catch (err) {
    reportScopeFailure('live_authority', err);
    await deny('scope_unverifiable');
    return;
  }
  if (!liveResult.ok || liveResult.authority.scope.kind === 'legacy_unscoped') {
    await deny(`scope_${liveResult.ok ? 'unverifiable_scope' : liveResult.reason}`);
    return;
  }

  // #3198 W02 (spec §2, ruling P8). A business type also needs its underlying
  // read permissions (e.g. invoices:read for ar_aging), re-checked here
  // against the execution user's LIVE role grants on the same axis the
  // resolver above used. The routes gate create/PUT/generate on the caller's
  // permission set; without this re-check a creator demoted off invoices:read
  // would keep receiving AR aging by email. Skipped (no query) for every
  // pre-#3198 type, which lists no extra permissions.
  // An unknown stored type (reportTypeDef throws) and a re-check that could
  // not run (DB failure) are "could not verify", not a permission loss.
  // Ruling F1: an msp_staff (business) type is internal to the MSP, so the
  // re-check resolves the PARTNER axis only — an execution user who reaches an
  // org-owned report through an org membership alone (a customer user) is
  // denied scope_permission_missing.
  let typePermissionsGranted: boolean;
  try {
    const typeDef = reportTypeDef(report.type);
    const requiredPermissions = typeDef.requiredPermissions;
    typePermissionsGranted = requiredPermissions.length === 0
      || await resolveLiveReportTypePermissions(
        liveResult.authority.principalUserId,
        owner,
        requiredPermissions,
        { partnerAxisOnly: typeDef.audience === 'msp_staff' },
      );
  } catch (err) {
    reportScopeFailure('live_permissions', err);
    await deny('scope_unverifiable');
    return;
  }
  if (!typePermissionsGranted) {
    await deny('scope_permission_missing');
    return;
  }

  const effectiveScope = intersectSiteScopes(
    persistedScope,
    liveResult.authority.scope,
  );
  if (!effectiveScope) {
    await deny('scope_no_intersection');
    return;
  }
  if (effectiveScope.kind === 'legacy_unscoped') {
    await deny('scope_legacy_unscoped');
    return;
  }
  if (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0) {
    await deny('scope_empty');
    return;
  }

  const executionAuthority: ReportExecutionAuthority = {
    principalKind: 'user',
    scope: effectiveScope,
    principalUserId: liveResult.authority.principalUserId,
    capturedAt: liveResult.authority.capturedAt,
    fingerprint: siteScopeFingerprint(effectiveScope),
  };

  try {
    // The type rides along so a stored config its own type rejects is a deny
    // here, not a failed run after a row exists (ruling T3e).
    assertReportExecutionPreflight(owner, config, executionAuthority, report.type);
  } catch {
    await deny('scope_config_outside_authority');
    return;
  }

  const [run] = await db
    .insert(reportRuns)
    .values({
      reportId: report.id,
      status: 'running',
      startedAt: new Date(),
      requestedByKind: 'user',
      requestedByUserId: executionAuthority.principalUserId,
      requestedByPortalUserId: null,
      ...persistedSiteScopeValues(executionAuthority),
    })
    .returning();
  if (!run) throw new Error(`Failed to create run for scheduled report ${report.id}`);

  // Stamp lastGeneratedAt up front so a crash mid-generation doesn't cause a
  // tight retry loop every check interval; the failed run row records the error.
  // Skipped when the caller already claimed the occurrence atomically (the
  // inline CAS path in processCheckSchedules) — that claim IS this stamp, and
  // re-stamping here would just be a redundant (harmless but pointless) write.
  if (!opts.occurrenceClaimed) {
    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, report.id));
  }

  try {
    // #3198 W02: the generator's scope comes from the owner axis and the
    // authority just resolved for it. A partner owner's org list is resolved
    // LIVE here (never stored on the definition), in this worker's system
    // context via runInReportScope. A type that cannot run under its owner
    // axis throws UnsupportedReportScopeError from the dispatcher, mapped to
    // a stable reason below.
    const scope = await reportScopeFromAuthority(owner, executionAuthority);
    const previous = await previousBaselineFor(
      report.id,
      executionAuthority.fingerprint,
    );
    const result = await generateReport(
      report.type,
      scope,
      config,
      executionAuthority,
    );
    if (previous) result.previous = previous;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const rowCount = result.rowCount ?? rows.length;
    await db
      .update(reportRuns)
      .set({
        status: 'completed',
        completedAt: new Date(),
        outputUrl: `/api/reports/runs/${run.id}/download`,
        result,
        rowCount,
      })
      .where(eq(reportRuns.id, run.id));

    const recipients = await resolveScheduledReportRecipients({
      reportId: report.id,
      orgId: owner.orgId ?? null,
      config,
    });
    if (recipients.length > 0) {
      try {
        // Timezone + branding are only needed to build the email — deferred
        // here (rather than fetched unconditionally for every run) so a
        // transient failure in either lookup can't sink a no-recipient run's
        // occurrence-keyed job (a failed job blocks re-enqueue of that
        // occurrence, and by this point the run row is already stored).
        const delivery = await resolveScheduledDeliveryContext(owner);

        await emailReportRun({
          reportName: report.name,
          reportType: report.type,
          format: report.format,
          recipients,
          rows,
          summary: result.summary,
          previous: result.previous,
          trendLine: trendLineOf(result),
          timezone: delivery.timeZone,
          branding: delivery.branding,
          partnerId: delivery.partnerId,
        });
      } catch (err) {
        // Delivery failure must not fail the (already stored) run.
        console.error(`[ReportScheduleWorker] Email delivery failed for report ${report.id}:`, err);
      }
    }
  } catch (err) {
    // #3198: a definition whose owner axis its type cannot run under is a
    // deterministic refusal, not a transient failure. It records the stable
    // reason and RESOLVES: a retry could only write the same failed row again,
    // and recipients are not told a report "failed" that cannot be produced.
    const unsupportedScope = err instanceof UnsupportedReportScopeError;
    await db
      .update(reportRuns)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: unsupportedScope
          ? 'unsupported_report_scope'
          : err instanceof Error ? err.message : 'Failed to generate report',
      })
      .where(eq(reportRuns.id, run.id));
    if (unsupportedScope) {
      console.warn('[ReportScheduleWorker] Report type cannot run under its owner scope', {
        reportId: report.id,
        type: report.type,
        scope: err.scope,
      });
      return;
    }

    // Only once the job is out of retries: an earlier attempt may still succeed,
    // and this occurrence will not be re-enqueued after the last one fails.
    if (opts.finalAttempt) {
      const recipients = await resolveScheduledReportRecipients({
        reportId: report.id,
        orgId: owner.orgId ?? null,
        config,
      });
      if (recipients.length > 0) {
        try {
          await emailReportFailure({ reportName: report.name, recipients });
        } catch (notifyErr) {
          console.error(`[ReportScheduleWorker] Failure notice undeliverable for report ${report.id}:`, notifyErr);
        }
      }
    }
    throw err;
  }
}

export async function processCheckSchedules(): Promise<void> {
  const due = await findDueReports(new Date());
  if (due.length === 0) return;
  console.log(`[ReportScheduleWorker] ${due.length} scheduled report(s) due`);

  for (const item of due) {
    if (!isRedisAvailable()) {
      // Inline fallback is 'all'-only: a worker-role process requires Redis to
      // boot at all (never this limp mode), and unlike 'all' — a single
      // self-hosted process — a worker-role deploy may run multiple replicas,
      // where bypassing the BullMQ jobId dedup would double-generate the same
      // occurrence across containers. Under worker/api roles with Redis down
      // (a transient blip after boot, since worker.ts's own mandatory check
      // already passed), skip rather than risk that — the next check interval
      // retries once Redis is back.
      if (breezeRole() !== 'all') {
        console.warn(
          `[ReportScheduleWorker] Redis unavailable outside 'all' role; skipping inline fallback for report ${item.id}`,
        );
        continue;
      }
      // Inline mode has no queue to absorb a throw, so one failing report would
      // abort the loop and silently starve every remaining org's reports.
      // There is no retry here either, hence finalAttempt.
      //
      // The occurrence is claimed via CAS before running: a slow prior tick
      // still mid-generation when the next 5-minute interval fires would
      // otherwise find the same report due twice (lastGeneratedAt isn't
      // stamped until deep inside processRunScheduledReport) and generate it
      // twice. The claim uses the lastGeneratedAt findDueReports observed, so
      // only the first tick to reach it wins.
      const claimed = await claimReportOccurrence(item.id, item.lastGeneratedAt);
      if (!claimed) {
        console.warn(
          `[ReportScheduleWorker] Occurrence for report ${item.id} already claimed by a concurrent check; skipping`,
        );
        continue;
      }
      try {
        await processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: item.id, occurrenceKey: item.occurrenceKey },
          { finalAttempt: true, occurrenceClaimed: true },
        );
      } catch (err) {
        console.error(`[ReportScheduleWorker] Inline run failed for report ${item.id}:`, err);
        captureException(err);
      }
      continue;
    }
    // Occurrence-keyed jobId dedupes double-enqueue across overlapping checks.
    await getReportScheduleQueue().add(
      'run-scheduled-report',
      { type: 'run-scheduled-report', reportId: item.id, occurrenceKey: item.occurrenceKey },
      {
        jobId: `report-sched-run-${item.id}-${item.occurrenceKey}`,
        // A transient blip must not cost the whole occurrence: lastGeneratedAt is
        // stamped before generation (deliberately — it stops a failed report from
        // being re-found due every check interval), so once these attempts are
        // spent the occurrence is gone until the next one.
        attempts: RUN_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    );
  }
}

// ─── Queue / worker lifecycle ────────────────────────────────────────────────

export function getReportScheduleQueue(): Queue<ReportScheduleJobData> {
  if (!reportScheduleQueue) {
    reportScheduleQueue = new Queue<ReportScheduleJobData>(REPORT_SCHEDULE_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return reportScheduleQueue;
}

/** Inline scheduler for Redis-less deploys: check on an interval, run inline. */
let inlineTimer: ReturnType<typeof setInterval> | null = null;

export async function initializeReportScheduleWorker(): Promise<void> {
  if (!isRedisAvailable()) {
    if (!inlineTimer) {
      inlineTimer = setInterval(() => {
        runWithSystemDbAccess(processCheckSchedules).catch((err) => {
          console.error('[ReportScheduleWorker] Inline schedule check failed:', err);
        });
      }, CHECK_INTERVAL_MS);
      inlineTimer.unref?.();
      console.warn('[ReportScheduleWorker] Redis unavailable; using inline interval scheduler');
    }
    return;
  }

  if (reportScheduleWorker) return;

  reportScheduleWorker = new Worker<ReportScheduleJobData>(
    REPORT_SCHEDULE_QUEUE,
    async (job: Job<ReportScheduleJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'check-schedules':
            return processCheckSchedules();
          case 'run-scheduled-report': {
            // attemptsMade counts attempts already finished, so on the last one
            // it is attempts-1 and this run is the occurrence's final chance.
            const allowed = job.opts.attempts ?? 1;
            return processRunScheduledReport(job.data, {
              finalAttempt: job.attemptsMade + 1 >= allowed,
            });
          }
          default:
            throw new Error(`Unknown report schedule job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  attachWorkerObservability(reportScheduleWorker, 'reportScheduleWorker');
  reportScheduleWorker.on('error', (error) => {
    console.error('[ReportScheduleWorker] Worker error:', error);
  });
  reportScheduleWorker.on('failed', (job, error) => {
    console.error(`[ReportScheduleWorker] Job ${job?.id} failed:`, error);
  });

  const queue = getReportScheduleQueue();
  await queue.add(
    'check-schedules',
    { type: 'check-schedules' },
    {
      repeat: { every: CHECK_INTERVAL_MS },
      jobId: 'report-schedules-check',
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  console.log('[ReportScheduleWorker] Initialized');
}

export async function shutdownReportScheduleWorker(): Promise<void> {
  if (inlineTimer) {
    clearInterval(inlineTimer);
    inlineTimer = null;
  }
  if (reportScheduleWorker) {
    await reportScheduleWorker.close();
    reportScheduleWorker = null;
  }
  if (reportScheduleQueue) {
    await reportScheduleQueue.close();
    reportScheduleQueue = null;
  }
  console.log('[ReportScheduleWorker] Shut down');
}
