import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { CAP_HIT_WINDOW_DAYS, loadCapHitWindow } from '../emailDomains/capHits';
import { utcWindowStartDay } from '../emailDomains/deliveryStats';
import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

/**
 * Partner sending-domain abuse signals (spec §9.2).
 *
 * Shape follows the file's siblings exactly: one fleet-wide async LOADER that
 * reads the database directly (and must run inside the sweep's system DB
 * context), plus a PURE, synchronous SCORER. Neither takes a clock, which is
 * this file's enforced documentation that none of these detectors age-decays:
 * a lookalike domain and a bounce storm are evidence about what the account is
 * doing, not about how recently it was created.
 *
 * Four detectors:
 *   email.sending_domain_added            info  — a human reads the NAME
 *   email.sending_domain_verify_failures  watch — names the partner cannot prove
 *   email.partner_lane_cap_hit            watch — blasting past the daily cap
 *   email.sending_bounce_complaint        watch — deliverability, capped below alert
 */

/** Evidence lists are bounded: index.ts truncates a serialized evidence blob at 800 chars. */
const EVIDENCE_CAP = 10;

export interface SendingDomainAggregate {
  partnerId: string;
  partnerName: string;
  recentDomains: Array<{ domain: string; createdAt: Date }>;
  failedVerifications: Array<{ domain: string; checkAttempts: number; statusReason: string | null }>;
  capHits: number;
  windowSent: number;
  windowDelivered: number;
  windowBounced: number;
  windowComplained: number;
  windowFailed: number;
  windowMessages: number;
  windowBounceRate: number;
}

interface AggregateRow {
  partner_id: string;
  partner_name: string;
  recent_domains: Array<{ domain: string; created_at: string }> | null;
  failed_verifications: Array<{ domain: string; check_attempts: number; status_reason: string | null }> | null;
  sent: string | number;
  delivered: string | number;
  bounced: string | number;
  complained: string | number;
  failed: string | number;
}

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

function num(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * ONE query for every partner that has a sending domain at all, plus one Redis
 * window read. Both the domain lists and the delivery counters are aggregated
 * in SQL so the sweep does not fan out per partner.
 *
 * MUST run inside the sweep's system DB context: partner_sending_domains and
 * partner_sending_daily_stats are partner-axis with forced RLS, so a contextless
 * read returns zero rows and would report a permanently clean fleet.
 */
export async function loadSendingDomainAggregates(now: Date = new Date()): Promise<{
  aggregates: SendingDomainAggregate[];
  scannedPartnerIds: string[];
}> {
  const addedWindowDays = 7;
  const statsWindowDays = 7;
  // Bound in UTC, never `current_date - N`: that is evaluated in the SESSION
  // time zone, and partner_sending_daily_stats rows are keyed on the UTC
  // calendar day, so a non-UTC connection would read a window shifted by a day.
  const statsWindowStart = utcWindowStartDay(now, statsWindowDays);

  const result = await db.execute(sql`
    with recent as (
      select
        d.partner_id,
        jsonb_agg(jsonb_build_object('domain', d.domain, 'created_at', d.created_at)
                  order by d.created_at desc) as domains
      from partner_sending_domains d
      where d.created_at >= now() - (${addedWindowDays} || ' days')::interval
      group by d.partner_id
    ),
    failures as (
      select
        d.partner_id,
        jsonb_agg(jsonb_build_object(
          'domain', d.domain,
          'check_attempts', d.check_attempts,
          'status_reason', d.status_reason
        ) order by d.status_changed_at desc) as rows
      from partner_sending_domains d
      where d.status = 'failed'
        and coalesce(d.status_reason, '') in ('dns_not_detected', 'provider_conflict', 'provider_rejected')
      group by d.partner_id
    ),
    stats as (
      select
        s.partner_id,
        coalesce(sum(s.sent), 0)       as sent,
        coalesce(sum(s.delivered), 0)  as delivered,
        coalesce(sum(s.bounced), 0)    as bounced,
        coalesce(sum(s.complained), 0) as complained,
        coalesce(sum(s.failed), 0)     as failed
      from partner_sending_daily_stats s
      where s.day >= ${statsWindowStart}::date
      group by s.partner_id
    ),
    scanned as (
      select distinct partner_id from partner_sending_domains
      union
      select distinct partner_id from stats
    )
    select
      p.id                                as partner_id,
      p.name                              as partner_name,
      recent.domains                      as recent_domains,
      failures.rows                       as failed_verifications,
      coalesce(stats.sent, 0)             as sent,
      coalesce(stats.delivered, 0)        as delivered,
      coalesce(stats.bounced, 0)          as bounced,
      coalesce(stats.complained, 0)       as complained,
      coalesce(stats.failed, 0)           as failed
    from scanned
    join partners p on p.id = scanned.partner_id
    left join recent   on recent.partner_id = scanned.partner_id
    left join failures on failures.partner_id = scanned.partner_id
    left join stats    on stats.partner_id = scanned.partner_id
    where p.deleted_at is null
  `);

  const rows = extractRows<AggregateRow>(result);
  const capHits = await loadCapHitWindow(now);

  const aggregates: SendingDomainAggregate[] = rows.map((row) => {
    const sent = num(row.sent);
    const delivered = num(row.delivered);
    const bounced = num(row.bounced);
    const complained = num(row.complained);
    const failed = num(row.failed);
    const messages = Math.max(sent, delivered + bounced + failed);
    return {
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      recentDomains: (row.recent_domains ?? []).map((d) => ({
        domain: d.domain,
        createdAt: new Date(d.created_at),
      })),
      failedVerifications: (row.failed_verifications ?? []).map((f) => ({
        domain: f.domain,
        checkAttempts: Number(f.check_attempts ?? 0),
        statusReason: f.status_reason,
      })),
      capHits: capHits.get(row.partner_id) ?? 0,
      windowSent: sent,
      windowDelivered: delivered,
      windowBounced: bounced,
      windowComplained: complained,
      windowFailed: failed,
      windowMessages: messages,
      windowBounceRate: messages > 0 ? bounced / messages : 0,
    };
  });

  // A partner that only appears in the cap-hit hash still has to be scanned, or
  // an open row for it would never stale-resolve.
  const scanned = new Set(aggregates.map((a) => a.partnerId));
  for (const partnerId of capHits.keys()) scanned.add(partnerId);

  return { aggregates, scannedPartnerIds: [...scanned] };
}

export function computeSendingDomainSignals(
  aggregates: SendingDomainAggregate[],
  cfg: SignalConfig,
): ComputedSignal[] {
  const signals: ComputedSignal[] = [];

  for (const agg of aggregates) {
    const base = { partnerName: agg.partnerName };

    if (agg.recentDomains.length > 0) {
      const score = cfg['email.sending_domain_added.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.sending_domain_added',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: {
          ...base,
          // The NAME is the whole point: only a human can see that
          // `acrne-bank.test` is a lookalike of a real brand (spec §9.2).
          domains: agg.recentDomains.slice(0, EVIDENCE_CAP).map((d) => d.domain),
          addedCount: agg.recentDomains.length,
          windowDays: cfg['email.sending_domain_added.window_days'],
        },
      });
    }

    if (agg.failedVerifications.length >= cfg['email.sending_domain_verify_failures.min_domains']) {
      const score = cfg['email.sending_domain_verify_failures.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.sending_domain_verify_failures',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: {
          ...base,
          failedDomains: agg.failedVerifications.slice(0, EVIDENCE_CAP).map((f) => f.domain),
          failedCount: agg.failedVerifications.length,
          reasons: [...new Set(agg.failedVerifications.map((f) => f.statusReason ?? 'unknown'))].slice(0, EVIDENCE_CAP),
        },
      });
    }

    if (agg.capHits >= cfg['email.partner_lane_cap_hit.min_hits']) {
      const score = cfg['email.partner_lane_cap_hit.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.partner_lane_cap_hit',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: { ...base, capHits: agg.capHits, windowDays: CAP_HIT_WINDOW_DAYS },
      });
    }

    const rateBreached =
      agg.windowMessages >= cfg['email.sending_bounce_complaint.min_messages'] &&
      agg.windowBounceRate > cfg['email.sending_bounce_complaint.bounce_rate'];
    const complaintsBreached = agg.windowComplained >= cfg['email.sending_bounce_complaint.min_complaints'];
    if (rateBreached || complaintsBreached) {
      const score = cfg['email.sending_bounce_complaint.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.sending_bounce_complaint',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: {
          ...base,
          messages: agg.windowMessages,
          bounced: agg.windowBounced,
          complained: agg.windowComplained,
          bounceRate: agg.windowBounceRate,
          // Says out loud that the kill switch has its own, independent path:
          // this signal is for the reviewer, not the page.
          note: 'automatic suspension is evaluated independently (spec §9.3)',
        },
      });
    }
  }

  return signals;
}
