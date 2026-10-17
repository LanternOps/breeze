import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getEmailService } from '../email';
import type { EmailOptoutTopic } from '../emailOptouts';
import { buildUnsubscribeUrl, signUnsubscribeToken } from '../emailUnsubscribeToken';
import { captureException } from '../sentry';
import { resolvePartnerUsersWithPermission } from '../usersWithPermission';
import { buildDigestEmail } from './digestEmail';
import { isDigestHour, localClock, planUserDigest, type DigestIncident, type LocalClock } from './digestPlan';
import {
  claimDelivery,
  deleteOldDeliveries,
  expireStaleClaims,
  insertSkippedEmpty,
  loadActiveUsers,
  loadCandidatePartners,
  loadLedgerForDate,
  loadOptedOut,
  loadPartnerIncidents,
  loadRecentSent,
  markDeliveryFailed,
  markDeliverySent,
  type DigestIncidentRow,
} from './digestStore';
import { permissionFromText } from './store';

// Daily connection health digest (spec 2026-10-15 §4, §5; W3 plan). Runs
// hourly; a partner is due while its local hour is 08–11 (plan D2) and each
// user gets at most one digest per local date:
//   claim (INSERT … ON CONFLICT DO NOTHING) → send → mark sent | failed.
// A claim left `claimed` for an hour is marked failed and never resent, and a
// failed send is never retried: a missed digest is better than a duplicate
// (§2.3). The catch-up window covers MISSED RUNS, not failed sends.
//
// Every partner due in one run shares the same local date (all show a local
// hour in 08–11 at the same instant, so no midnight lies between them), so a
// user who is a recipient in several due partners gets ONE merged digest.
//
// Recipients and each incident's view permission are recomputed at send time
// (§4 authorization recheck). DB work runs in short system-scope transactions;
// the email send itself is outside any transaction.

export const DIGEST_TOPIC: EmailOptoutTopic = 'connection_health_digest';
const CLAIM_STALE_MS = 60 * 60 * 1000;
/** Recovered incidents and sent digests older than this are not considered for the restored list. */
const RESTORED_LOOKBACK_DAYS = 30;
const LEDGER_RETENTION_DAYS = 90;
const RETENTION_BATCH = 1000;

export type DigestRunResult = {
  skipped?: 'email_unconfigured';
  partners: number;
  partnerFailures: number;
  sent: number;
  /** The provider rejected the send: the ledger row is `failed` and is never retried. */
  failed: number;
  /** An error before the claim (plan, render, ledger write): no row was claimed, so a later run in the window retries. */
  errored: number;
  skippedEmpty: number;
  optedOut: number;
  alreadyHandled: number;
  claimConflicts: number;
  expired: number;
  retained: number;
  maintenanceFailures: number;
};

type SendEmail = (params: Parameters<NonNullable<ReturnType<typeof getEmailService>>['sendEmail']>[0]) => Promise<void>;

const sys = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

function utcDateMinusDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function dateMinusDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One incident as one user will see it. `viaOwner` items require the owner to still belong to the incident's partner. */
type AudienceItem = DigestIncident & { partnerId: string; viaOwner: boolean };
type Audience = Map<string, AudienceItem[]>;

/**
 * Adds, per user, the incidents they may see right now. Admins: partner-scope
 * users holding the repair permission AND the view permission for the
 * incident's org (partner-wide: orgAccess = all only). Owner: always, with the
 * owner link (plan D6); their active status and partner membership are checked
 * with the user rows.
 */
async function addPartnerAudience(audience: Audience, partnerId: string, rows: readonly DigestIncidentRow[]): Promise<void> {
  const memo = new Map<string, Promise<Set<string>>>();
  const holders = (permission: string, orgId: string | null) => {
    const key = `${permission}|${orgId ?? ''}`;
    let p = memo.get(key);
    if (!p) {
      p = resolvePartnerUsersWithPermission(partnerId, permissionFromText(permission), orgId ? { orgId } : {})
        .then((ids) => new Set(ids));
      memo.set(key, p);
    }
    return p;
  };
  const add = (userId: string, item: AudienceItem) => {
    const list = audience.get(userId);
    if (list) list.push(item);
    else audience.set(userId, [item]);
  };

  for (const r of rows) {
    // Sequential on purpose: both reads share this partner's one system transaction.
    const repair = await holders(r.repairPermission, r.orgId);
    const view = await holders(r.viewPermission, r.orgId);
    const base: AudienceItem = {
      id: r.id,
      partnerId: r.partnerId,
      viaOwner: false,
      orgId: r.orgId,
      orgName: r.orgName,
      displayName: r.displayName,
      condition: r.condition,
      severity: r.severity,
      detail: r.detail,
      fixHref: r.fixHref,
      openedAt: r.openedAt,
      resolvedAt: r.resolvedAt,
      resolution: r.resolution,
    };
    for (const userId of repair) {
      if (userId !== r.ownerUserId && view.has(userId)) add(userId, base);
    }
    if (r.ownerUserId) add(r.ownerUserId, { ...base, viaOwner: true, fixHref: r.ownerFixHref ?? r.fixHref });
  }
}

async function deliverDigests(
  audience: Audience,
  clock: LocalClock,
  timeZone: string,
  now: Date,
  sendEmail: SendEmail,
  result: DigestRunResult,
): Promise<void> {
  const candidateIds = [...audience.keys()];
  if (candidateIds.length === 0) return;

  const { activeUsers, optedOut, handled, recent } = await sys(async () => ({
    activeUsers: await loadActiveUsers(candidateIds),
    optedOut: await loadOptedOut(candidateIds, DIGEST_TOPIC),
    handled: await loadLedgerForDate(candidateIds, clock.date),
    recent: await loadRecentSent(candidateIds, dateMinusDays(clock.date, RESTORED_LOOKBACK_DAYS)),
  }), 'connectionHealthDigest.users');

  const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');

  for (const user of activeUsers) {
    if (optedOut.has(user.id)) { result.optedOut += 1; continue; }
    if (handled.has(user.id)) { result.alreadyHandled += 1; continue; }

    // An owner who has since left the incident's partner no longer hears about it.
    const items = (audience.get(user.id) ?? []).filter((i) => !i.viaOwner || i.partnerId === user.partnerId);
    const prior = recent.get(user.id);
    let stage = 'plan';
    try {
      const plan = planUserDigest({
        open: items.filter((i) => i.resolvedAt === null),
        resolved: items.filter((i) => i.resolvedAt !== null),
        toldIncidentIds: prior?.told ?? new Set(),
        lastSentAt: prior?.lastSentAt ?? null,
        now,
        timeZone,
      });

      if (!plan) {
        stage = 'skip';
        await sys(() => insertSkippedEmpty(user.id, clock.date, new Date()), 'connectionHealthDigest.skip');
        result.skippedEmpty += 1;
        continue;
      }

      // Built before the claim: a failure here must not burn the user's one claim for the day.
      stage = 'render';
      const unsubscribeUrl = buildUnsubscribeUrl(user.id, DIGEST_TOPIC);
      const message = buildDigestEmail({ plan, now, timeZone, appBaseUrl, unsubscribeUrl });
      const incidentIds = [...plan.open, ...plan.restored].map((i) => i.id);

      stage = 'claim';
      // Stamped at claim time, not run start, so the stale sweep measures the claim's real age.
      const claimId = await sys(() => claimDelivery(user.id, clock.date, incidentIds, new Date()), 'connectionHealthDigest.claim');
      if (!claimId) { result.claimConflicts += 1; continue; }

      try {
        await sendEmail({
          to: user.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          purpose: 'staff.connection_health_digest',
        });
      } catch (err) {
        result.failed += 1;
        console.error(JSON.stringify({ event: 'connection_health_digest_send_failed', userId: user.id, error: errorText(err) }));
        await sys(() => markDeliveryFailed(claimId, errorText(err)), 'connectionHealthDigest.failed').catch((markErr) => {
          // The row stays `claimed`; the stale sweep marks it failed in an hour. Never resent either way.
          console.error(JSON.stringify({ event: 'connection_health_digest_mark_failed_failed', claimId, error: errorText(markErr) }));
        });
        continue;
      }
      result.sent += 1;
      await sys(() => markDeliverySent(claimId, new Date()), 'connectionHealthDigest.sent').catch((markErr) => {
        // The email WAS sent. The row stays `claimed` and the stale sweep marks it
        // failed ("claim expired"), so the next digest may repeat what this one said.
        // At most once still holds.
        console.error(JSON.stringify({ event: 'connection_health_digest_sent_but_unrecorded', claimId, error: errorText(markErr) }));
      });
    } catch (err) {
      result.errored += 1;
      console.error(JSON.stringify({ event: 'connection_health_digest_user_errored', stage, userId: user.id, error: errorText(err) }));
    }
  }
}

/** Housekeeping must never block delivery: each step logs and counts its own failure. */
async function maintenance(now: Date, result: DigestRunResult): Promise<void> {
  try {
    result.expired = await sys(() => expireStaleClaims(new Date(now.getTime() - CLAIM_STALE_MS)), 'connectionHealthDigest.expire');
  } catch (err) {
    result.maintenanceFailures += 1;
    console.error(JSON.stringify({ event: 'connection_health_digest_maintenance_failed', step: 'expire', error: errorText(err) }));
  }
  try {
    result.retained = await sys(
      () => deleteOldDeliveries(utcDateMinusDays(now, LEDGER_RETENTION_DAYS), RETENTION_BATCH),
      'connectionHealthDigest.retention',
    );
  } catch (err) {
    result.maintenanceFailures += 1;
    console.error(JSON.stringify({ event: 'connection_health_digest_maintenance_failed', step: 'retention', error: errorText(err) }));
  }
}

export async function runDigest(now: Date = new Date()): Promise<DigestRunResult> {
  const result: DigestRunResult = {
    partners: 0,
    partnerFailures: 0,
    sent: 0,
    failed: 0,
    errored: 0,
    skippedEmpty: 0,
    optedOut: 0,
    alreadyHandled: 0,
    claimConflicts: 0,
    expired: 0,
    retained: 0,
    maintenanceFailures: 0,
  };
  const email = getEmailService();
  if (!email) {
    // No ledger writes: when email is configured later, today's digest still goes out.
    console.warn(JSON.stringify({ event: 'connection_health_digest_skipped', reason: 'email_unconfigured' }));
    return { ...result, skipped: 'email_unconfigured' };
  }
  // Fail the job loudly (BullMQ failure + Sentry) rather than erroring once per
  // user: without a signing secret no digest can carry its unsubscribe link.
  signUnsubscribeToken({ userId: '00000000-0000-4000-8000-000000000000', topic: DIGEST_TOPIC });

  await maintenance(now, result);

  const since = new Date(now.getTime() - RESTORED_LOOKBACK_DAYS * 86_400_000);
  const partnerRows = await sys(() => loadCandidatePartners(since), 'connectionHealthDigest.partners');
  const due = partnerRows
    .map((p) => ({ ...p, clock: localClock(now, p.timezone) }))
    .filter((p) => isDigestHour(p.clock.hour))
    .sort((a, b) => a.id.localeCompare(b.id));

  const audience: Audience = new Map();
  for (const partner of due) {
    result.partners += 1;
    try {
      const rows = await sys(() => loadPartnerIncidents(partner.id, since), 'connectionHealthDigest.incidents');
      if (rows.length === 0) continue;
      await sys(() => addPartnerAudience(audience, partner.id, rows), 'connectionHealthDigest.audience');
    } catch (err) {
      result.partnerFailures += 1;
      console.error(JSON.stringify({ event: 'connection_health_digest_partner_failed', partnerId: partner.id, error: errorText(err) }));
    }
  }

  if (due.length > 0) {
    // All due partners share one local date (see top); the first partner's zone
    // is used for ages, which can differ from another due zone by at most a day.
    const { clock, timezone } = due[0]!;
    await deliverDigests(audience, clock, timezone, now, (p) => email.sendEmail(p), result);
  }

  console.log(JSON.stringify({ event: 'connection_health_digest_run', ...result }));
  const nothingDelivered = (result.failed > 0 || result.errored > 0) && result.sent === 0;
  if (result.partnerFailures > 0 || result.maintenanceFailures > 0 || nothingDelivered) {
    captureException(new Error('connection_health_digest_degraded'), undefined, {
      partners: String(result.partners),
      partnerFailures: String(result.partnerFailures),
      sent: String(result.sent),
      failed: String(result.failed),
      errored: String(result.errored),
      maintenanceFailures: String(result.maintenanceFailures),
    }, { fingerprint: ['connection_health_digest_degraded'] });
  }
  return result;
}
