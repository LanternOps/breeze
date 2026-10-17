import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getEmailService } from '../email';
import type { EmailOptoutTopic } from '../emailOptouts';
import { buildUnsubscribeUrl } from '../emailUnsubscribeToken';
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
// user gets at most one digest per partner-local date:
//   claim (INSERT … ON CONFLICT DO NOTHING) → send → mark sent | failed.
// A claim left `claimed` for an hour is marked failed and never resent: a
// missed digest is better than a duplicate (§2.3).
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
  failed: number;
  skippedEmpty: number;
  optedOut: number;
  alreadyHandled: number;
  claimConflicts: number;
  expired: number;
  retained: number;
};

const sys = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

function utcDateMinusDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function dateMinusDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Audience = Map<string, DigestIncident[]>;

/**
 * Per user, the incidents they may see right now. Admins: partner-scope users
 * holding the repair permission AND the view permission for the incident's org
 * (partner-wide: orgAccess = all only). Owner: always, with the owner link
 * (plan D6); their active status is checked with everyone else's.
 */
async function resolveAudience(partnerId: string, rows: readonly DigestIncidentRow[]): Promise<Audience> {
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

  const audience: Audience = new Map();
  const add = (userId: string, item: DigestIncident) => {
    const list = audience.get(userId);
    if (list) list.push(item);
    else audience.set(userId, [item]);
  };

  for (const r of rows) {
    // Sequential on purpose: both reads share this run's one system transaction.
    const repair = await holders(r.repairPermission, r.orgId);
    const view = await holders(r.viewPermission, r.orgId);
    const base: DigestIncident = {
      id: r.id,
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
    if (r.ownerUserId) add(r.ownerUserId, { ...base, fixHref: r.ownerFixHref ?? r.fixHref });
  }
  return audience;
}

async function digestPartner(
  partner: { id: string; timezone: string },
  clock: LocalClock,
  now: Date,
  sendEmail: (params: Parameters<NonNullable<ReturnType<typeof getEmailService>>['sendEmail']>[0]) => Promise<void>,
  result: DigestRunResult,
): Promise<void> {
  const since = new Date(now.getTime() - RESTORED_LOOKBACK_DAYS * 86_400_000);
  const rows = await sys(() => loadPartnerIncidents(partner.id, since), 'connectionHealthDigest.incidents');
  if (rows.length === 0) return;

  const audience = await sys(() => resolveAudience(partner.id, rows), 'connectionHealthDigest.audience');
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

    const items = audience.get(user.id) ?? [];
    const prior = recent.get(user.id);
    const plan = planUserDigest({
      open: items.filter((i) => i.resolvedAt === null),
      resolved: items.filter((i) => i.resolvedAt !== null),
      toldIncidentIds: prior?.told ?? new Set(),
      lastSentAt: prior?.lastSentAt ?? null,
      now,
      timeZone: partner.timezone,
    });

    try {
      if (!plan) {
        await sys(() => insertSkippedEmpty(user.id, clock.date, now), 'connectionHealthDigest.skip');
        result.skippedEmpty += 1;
        continue;
      }

      // Built before the claim: a failure here (e.g. no signing secret) must
      // not burn the user's one claim for the day.
      const unsubscribeUrl = buildUnsubscribeUrl(user.id, DIGEST_TOPIC);
      const message = buildDigestEmail({ plan, now, timeZone: partner.timezone, appBaseUrl, unsubscribeUrl });
      const incidentIds = [...plan.open, ...plan.restored].map((i) => i.id);

      const claimId = await sys(() => claimDelivery(user.id, clock.date, incidentIds, now), 'connectionHealthDigest.claim');
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
        console.error(JSON.stringify({ event: 'connection_health_digest_send_failed', userId: user.id, partnerId: partner.id, error: errorText(err) }));
        await sys(() => markDeliveryFailed(claimId, errorText(err)), 'connectionHealthDigest.failed').catch((markErr) => {
          // The row stays `claimed`; the stale sweep marks it failed in an hour. Never resent either way.
          console.error(JSON.stringify({ event: 'connection_health_digest_mark_failed_failed', claimId, error: errorText(markErr) }));
        });
        continue;
      }
      result.sent += 1;
      await sys(() => markDeliverySent(claimId, new Date()), 'connectionHealthDigest.sent').catch((markErr) => {
        // Sent but unrecorded: the stale sweep will mark it failed. At most once still holds.
        console.error(JSON.stringify({ event: 'connection_health_digest_mark_sent_failed', claimId, error: errorText(markErr) }));
      });
    } catch (err) {
      result.failed += 1;
      console.error(JSON.stringify({ event: 'connection_health_digest_user_failed', userId: user.id, partnerId: partner.id, error: errorText(err) }));
    }
  }
}

export async function runDigest(now: Date = new Date()): Promise<DigestRunResult> {
  const result: DigestRunResult = {
    partners: 0,
    partnerFailures: 0,
    sent: 0,
    failed: 0,
    skippedEmpty: 0,
    optedOut: 0,
    alreadyHandled: 0,
    claimConflicts: 0,
    expired: 0,
    retained: 0,
  };
  const email = getEmailService();
  if (!email) {
    // No ledger writes: when email is configured later, today's digest still goes out.
    return { ...result, skipped: 'email_unconfigured' };
  }

  result.expired = await sys(() => expireStaleClaims(new Date(now.getTime() - CLAIM_STALE_MS)), 'connectionHealthDigest.expire');
  result.retained = await sys(
    () => deleteOldDeliveries(utcDateMinusDays(now, LEDGER_RETENTION_DAYS), RETENTION_BATCH),
    'connectionHealthDigest.retention',
  );

  const since = new Date(now.getTime() - RESTORED_LOOKBACK_DAYS * 86_400_000);
  const partnerRows = await sys(() => loadCandidatePartners(since), 'connectionHealthDigest.partners');
  for (const partner of partnerRows) {
    const clock = localClock(now, partner.timezone);
    if (!isDigestHour(clock.hour)) continue;
    result.partners += 1;
    try {
      await digestPartner(partner, clock, now, (p) => email.sendEmail(p), result);
    } catch (err) {
      result.partnerFailures += 1;
      console.error(JSON.stringify({ event: 'connection_health_digest_partner_failed', partnerId: partner.id, error: errorText(err) }));
    }
  }

  console.log(JSON.stringify({ event: 'connection_health_digest_run', ...result }));
  return result;
}
