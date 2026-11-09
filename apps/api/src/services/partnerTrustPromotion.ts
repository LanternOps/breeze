import { and, eq, isNull, sql } from 'drizzle-orm';

import { partnerTrustMode } from '../config/partnerTrustMode';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations, partnerAbuseSignals, partners } from '../db/schema';
import type { IpClass, PartnerTrustState } from '../db/schema/orgs';
import { loadSignalConfig } from './abuseSignals/config';
import { ANONYMOUS_ACTOR_ID } from './auditEvents';
import { createAuditLogAsync } from './auditService';
import { getBreezeBillingClient, type CloseOpenCheckoutsResult } from './breezeBillingClient';
import { sendOpsAlert } from './opsAlerts';
import { readTrust } from './partnerTrust.repo';
import { setTrustState } from './partnerTrust';
import { sendEvidenceCard } from './partnerTrustEvidenceCard';
import { captureException } from './sentry';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Free/webmail domains excluded from the email-domain corroboration axis in
 * evaluateHardDenies. A shared @gmail.com (etc.) address is not identity
 * corroboration — millions of unrelated signups share these domains, so
 * treating one as a second axis alongside a shared IP prefix would restrict
 * unrelated partners on pure coincidence.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'mail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.co.uk',
  'yandex.com',
  'yandex.ru',
  'yandex.by',
  'yandex.kz',
  'yandex.ua',
  'yandex.com.tr',
]);

/**
 * Abuse signals that, once open at or above `severity.alert_score`, are an
 * independently sufficient hard deny (see evaluateHardDenies). The abuse sweep
 * evaluates hard denies for these partners as soon as it persists the signal,
 * so a restriction lands within the sweep tick instead of waiting for the next
 * promotion run.
 *
 * "Open" means unresolved. An acknowledged signal still counts: acknowledging
 * only silences re-notification and the digest (routes/admin/abuse.ts), it is
 * not a dismissal, which is the same reading promotionDecision's
 * unresolved_alert blocker already uses. The appeal is promote-with-override.
 */
export const AUTO_RESTRICT_SIGNAL_KEYS = ['billing.card_testing', 'rmm.recidivist_endpoint'] as const;

/**
 * Keys copied from the open `billing.card_testing` signal's evidence into the
 * restriction's evidence: the burst itself (how many cards, how many failures,
 * over what span). An explicit allowlist, because the signal row also carries
 * triage fields (partnerName, identitySyncedAt) that do not belong on the
 * restriction audit row.
 */
const CARD_TESTING_EVIDENCE_KEYS = [
  'distinctPaymentMethods',
  'failedAttempts',
  'spanMinutes',
  'paymentMethodsFirstSeenAt',
  'paymentMethodsLastSeenAt',
] as const;

export interface PromotionFacts {
  createdAt: Date;
  emailVerified: boolean;
  settledCard: { chargeId: string; settledAt: Date } | null;
  signupIpClass: IpClass;
  deviceIpClasses: IpClass[];
  unresolvedAlerts: number;
  billingHold: boolean;
  /**
   * True when the billing service could not tell us the risk-hold status
   * (breeze-billing 404s or the request fails) rather than affirmatively
   * reporting the partner clear. `billingHold` is forced true in this case
   * (fail closed — see gatherPromotionFacts) and this flag is what lets
   * promotionDecision report the distinct 'billing_hold_unknown' blocker.
   */
  billingHoldUnknown: boolean;
}

export type PromotionBlocker =
  | 'card_not_settled'
  | 'settled_too_recent'
  | 'signup_ip_hosting'
  | 'signup_ip_unclassified'
  | 'device_on_tor'
  | 'unresolved_alert'
  | 'billing_hold'
  | 'billing_hold_unknown'
  | 'email_unverified'
  | 'too_young';

export type HardDenyDecision =
  | { restrict: true; reason: string; evidence: Record<string, unknown> }
  | { restrict: false };

interface HardDenyRow {
  trust_state: PartnerTrustState;
  signup_ip_class: IpClass;
  card_partner_id: string | null;
  network_partner_id: string | null;
  candidate_ip: string | null;
  suspended_ip: string | null;
  prefix_length: number | null;
  corroboration_type: 'email_domain' | 'billing_card_fingerprint' | 'signup_user_agent_hostname_prefix' | null;
  corroboration_value: string | null;
  recidivist_partner_id: string | null;
  card_testing_signal_id: string | null;
  card_testing_score: number | string | null;
  card_testing_evidence: Record<string, unknown> | null;
}

/**
 * Evaluates local, independently sufficient abuse signals under a system DB
 * context. Returning no row means the partner is absent or no longer in
 * probation, which also prevents a billing outage from affecting trusted or
 * already-restricted partners.
 */
export async function evaluateHardDenies(partnerId: string): Promise<HardDenyDecision> {
  // Read per evaluation (not module load) so ABUSE_SIGNAL_OVERRIDES applies,
  // and so this gate always agrees with the threshold that made the signal an
  // alert in the first place.
  const alertScore = loadSignalConfig()['severity.alert_score'];
  const freeMailDomains = sql.join(
    [...FREE_MAIL_DOMAINS].map((domain) => sql`${domain}`),
    sql`, `,
  );
  const row = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      WITH target AS (
        SELECT id, trust_state, signup_ip, signup_ip_class, signup_user_agent, billing_card_fingerprint
        FROM partners
        WHERE id = ${partnerId} AND trust_state = 'probation'
      ),
      suspended_abuse AS (
        SELECT DISTINCT p.id, p.signup_ip, p.signup_user_agent, p.billing_card_fingerprint
        FROM partners p
        JOIN audit_logs a
          ON a.resource_id = p.id
         AND a.resource_type = 'partner'
         AND a.action = 'partner.suspended_for_abuse'
        WHERE p.status = 'suspended'
      ),
      recent_suspended_abuse AS (
        SELECT DISTINCT p.id, p.signup_ip, p.signup_user_agent, p.billing_card_fingerprint
        FROM partners p
        JOIN audit_logs a
          ON a.resource_id = p.id
         AND a.resource_type = 'partner'
         AND a.action = 'partner.suspended_for_abuse'
         AND a.timestamp >= now() - interval '90 days'
        WHERE p.status = 'suspended'
      ),
      target_ips AS (
        SELECT t.signup_ip AS ip FROM target t WHERE t.signup_ip IS NOT NULL
        UNION ALL
        SELECT d.enrollment_ip AS ip
        FROM devices d
        JOIN organizations o ON o.id = d.org_id
        JOIN target t ON t.id = o.partner_id
        WHERE d.enrollment_ip IS NOT NULL
      ),
      suspended_ips AS (
        SELECT s.id AS partner_id, s.signup_ip AS ip
        FROM recent_suspended_abuse s WHERE s.signup_ip IS NOT NULL
        UNION ALL
        SELECT s.id AS partner_id, d.enrollment_ip AS ip
        FROM recent_suspended_abuse s
        JOIN organizations o ON o.partner_id = s.id
        JOIN devices d ON d.org_id = o.id
        WHERE d.enrollment_ip IS NOT NULL
      ),
      network_matches AS (
        SELECT
          s.id AS partner_id,
          ti.ip AS candidate_ip,
          si.ip AS suspended_ip,
          CASE WHEN family(host(ti.ip::inet)::inet) = 4 THEN 24 ELSE 64 END AS prefix_length,
          CASE
            WHEN email_match.domain IS NOT NULL THEN 'email_domain'
            WHEN t.billing_card_fingerprint IS NOT NULL
              AND t.billing_card_fingerprint = s.billing_card_fingerprint
              THEN 'billing_card_fingerprint'
            WHEN t.signup_user_agent IS NOT NULL
              AND t.signup_user_agent = s.signup_user_agent
              AND hostname_match.prefix IS NOT NULL
              THEN 'signup_user_agent_hostname_prefix'
          END AS corroboration_type,
          COALESCE(
            email_match.domain,
            CASE WHEN t.billing_card_fingerprint IS NOT NULL
              AND t.billing_card_fingerprint = s.billing_card_fingerprint
              THEN t.billing_card_fingerprint END,
            hostname_match.prefix
          ) AS corroboration_value
        FROM target t
        CROSS JOIN target_ips ti
        JOIN suspended_ips si
          ON family(host(ti.ip::inet)::inet) = family(host(si.ip::inet)::inet)
         -- inet retains the host bits after set_masklen (only cidr zeroes
         -- them), so comparing two set_masklen(...)::inet values only matches
         -- byte-identical addresses, never two distinct IPs sharing a
         -- prefix. Cast to ::cidr to compare actual network addresses.
         AND set_masklen(
           host(ti.ip::inet)::inet,
           CASE WHEN family(host(ti.ip::inet)::inet) = 4 THEN 24 ELSE 64 END
         )::cidr = set_masklen(
           host(si.ip::inet)::inet,
           CASE WHEN family(host(si.ip::inet)::inet) = 4 THEN 24 ELSE 64 END
         )::cidr
        JOIN recent_suspended_abuse s ON s.id = si.partner_id AND s.id <> t.id
        LEFT JOIN LATERAL (
          SELECT lower(split_part(tu.email, '@', 2)) AS domain
          FROM users tu
          JOIN users su
            ON su.partner_id = s.id
           AND lower(split_part(su.email, '@', 2)) = lower(split_part(tu.email, '@', 2))
          WHERE tu.partner_id = t.id
            AND split_part(tu.email, '@', 2) <> ''
            AND lower(split_part(tu.email, '@', 2)) <> ALL(ARRAY[${freeMailDomains}]::text[])
          LIMIT 1
        ) email_match ON true
        LEFT JOIN LATERAL (
          SELECT left(lower(td.hostname), 6) AS prefix
          FROM devices td
          JOIN organizations tor_org ON tor_org.id = td.org_id AND tor_org.partner_id = t.id
          JOIN devices sd
            ON length(td.hostname) >= 6
           AND length(sd.hostname) >= 6
           AND left(lower(sd.hostname), 6) = left(lower(td.hostname), 6)
          JOIN organizations sus_org ON sus_org.id = sd.org_id AND sus_org.partner_id = s.id
          LIMIT 1
        ) hostname_match ON true
        WHERE email_match.domain IS NOT NULL
           OR (t.billing_card_fingerprint IS NOT NULL
             AND t.billing_card_fingerprint = s.billing_card_fingerprint)
           OR (t.signup_user_agent IS NOT NULL
             AND t.signup_user_agent = s.signup_user_agent
             AND hostname_match.prefix IS NOT NULL)
        ORDER BY s.id, ti.ip, si.ip
        LIMIT 1
      )
      SELECT
        t.trust_state,
        t.signup_ip_class,
        card_match.partner_id AS card_partner_id,
        network_match.partner_id AS network_partner_id,
        network_match.candidate_ip,
        network_match.suspended_ip,
        network_match.prefix_length,
        network_match.corroboration_type,
        network_match.corroboration_value,
        recidivist_match.partner_id AS recidivist_partner_id,
        card_testing.id AS card_testing_signal_id,
        card_testing.score AS card_testing_score,
        card_testing.evidence AS card_testing_evidence
      FROM target t
      LEFT JOIN LATERAL (
        SELECT s.id AS partner_id
        FROM suspended_abuse s
        WHERE s.id <> t.id
          AND t.billing_card_fingerprint IS NOT NULL
          AND t.billing_card_fingerprint = s.billing_card_fingerprint
        ORDER BY s.id
        LIMIT 1
      ) card_match ON true
      LEFT JOIN LATERAL (
        SELECT * FROM network_matches
      ) network_match ON true
      -- Recidivist endpoint: the partner holds the same remote-tool INSTANCE
      -- identifier as a partner suspended for abuse, and the sweep has an open
      -- alert-score rmm.recidivist_endpoint signal for it. Only the stable
      -- instance id counts: a hostname or a product name can coincide between
      -- unrelated MSPs (both running the same remote tool is normal), an
      -- instance id cannot. Bounded to suspensions in the last 90 days, like
      -- the network axis: the residual false positive is a legitimate MSP
      -- enrolling an endpoint that still carries an old operator's client, and
      -- that gets likelier the older the suspension. The signal itself still
      -- fires for review past the window.
      LEFT JOIN LATERAL (
        SELECT s.id AS partner_id
        FROM recent_suspended_abuse s
        JOIN abuse_endpoint_fingerprints sf
          ON sf.partner_id = s.id AND sf.kind = 'remote_tool_guid'
        JOIN abuse_endpoint_fingerprints tf
          ON tf.partner_id = t.id AND tf.kind = 'remote_tool_guid' AND tf.value = sf.value
        WHERE s.id <> t.id
          AND EXISTS (
            SELECT 1 FROM partner_abuse_signals pas
            WHERE pas.partner_id = t.id
              AND pas.signal_key = 'rmm.recidivist_endpoint'
              AND pas.resolved_at IS NULL
              AND pas.score >= ${alertScore}
          )
        ORDER BY s.id
        LIMIT 1
      ) recidivist_match ON true
      -- Card testing: an open billing.card_testing signal at or above the
      -- alert score. Unlike every other axis this is a behaviour, not a
      -- correlation: many distinct cards tried in a short span. At most one
      -- row: partner_abuse_signals_open_uq allows one open row per signal.
      LEFT JOIN LATERAL (
        SELECT pas.id, pas.score, pas.evidence
        FROM partner_abuse_signals pas
        WHERE pas.partner_id = t.id
          AND pas.signal_key = 'billing.card_testing'
          AND pas.resolved_at IS NULL
          AND pas.score >= ${alertScore}
        LIMIT 1
      ) card_testing ON true
    `)) as unknown as HardDenyRow[];
    return rows[0] ?? null;
  }, 'partnerTrustPromotion.hardDenies'));

  // The SQL target CTE already filters to trust_state='probation'; this is a
  // belt-and-suspenders check against the same field on the returned row so
  // a future edit that loosens that WHERE clause can't silently start
  // restricting trusted/restricted partners.
  if (!row || row.trust_state !== 'probation') return { restrict: false };
  if (row.signup_ip_class === 'tor') {
    return {
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
    };
  }
  if (row.card_partner_id) {
    return {
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: {
        matchedAxes: ['billing_card_fingerprint', 'suspended_for_abuse'],
        matchedSuspendedPartnerId: row.card_partner_id,
      },
    };
  }
  if (row.network_partner_id && row.corroboration_type) {
    return {
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: {
        matchedAxes: ['network_prefix', row.corroboration_type],
        matchedSuspendedPartnerId: row.network_partner_id,
        network: {
          candidateIp: row.candidate_ip,
          suspendedIp: row.suspended_ip,
          prefixLength: row.prefix_length,
        },
        corroboration: {
          type: row.corroboration_type,
          value: row.corroboration_value,
        },
      },
    };
  }
  if (row.recidivist_partner_id) {
    return {
      restrict: true,
      reason: 'auto:recidivist_endpoint',
      evidence: {
        matchedAxes: ['remote_tool_guid', 'suspended_for_abuse'],
        matchedSuspendedPartnerId: row.recidivist_partner_id,
      },
    };
  }
  if (row.card_testing_signal_id) {
    const signalEvidence = row.card_testing_evidence && typeof row.card_testing_evidence === 'object'
      ? row.card_testing_evidence
      : {};
    const copied: Record<string, unknown> = {};
    for (const key of CARD_TESTING_EVIDENCE_KEYS) {
      if (key in signalEvidence) copied[key] = signalEvidence[key];
    }
    return {
      restrict: true,
      reason: 'auto:card_testing',
      evidence: {
        matchedAxes: ['billing.card_testing'],
        signalId: row.card_testing_signal_id,
        score: Number(row.card_testing_score),
        alertScore,
        ...copied,
      },
    };
  }

  try {
    if (await getBreezeBillingClient().hasFraudulentRefundMatch(partnerId)) {
      return {
        restrict: true,
        reason: 'auto:fraud_identity_match',
        evidence: { matchedAxes: ['fraudulent_refund_customer'] },
      };
    }
  } catch (error) {
    // Fail open for this optional corroboration endpoint. The client normally
    // absorbs request failures; this also covers missing local configuration.
    console.warn(`[partnerTrustPromotion] fraudulent-refund lookup failed for partner ${partnerId}`, error);
  }
  return { restrict: false };
}

export function promotionDecision(
  facts: PromotionFacts,
  now: Date,
): { promote: true; reason: 'auto:settled_card_24h' } | { promote: false; blockers: PromotionBlocker[] } {
  const blockers: PromotionBlocker[] = [];
  if (!facts.settledCard) blockers.push('card_not_settled');
  else if (now.getTime() - facts.settledCard.settledAt.getTime() < DAY_MS) blockers.push('settled_too_recent');
  if (facts.signupIpClass === 'unknown') blockers.push('signup_ip_unclassified');
  else if (['hosting', 'vpn', 'tor'].includes(facts.signupIpClass)) blockers.push('signup_ip_hosting');
  if (facts.deviceIpClasses.includes('tor')) blockers.push('device_on_tor');
  if (facts.unresolvedAlerts > 0) blockers.push('unresolved_alert');
  if (facts.billingHold) blockers.push(facts.billingHoldUnknown ? 'billing_hold_unknown' : 'billing_hold');
  if (!facts.emailVerified) blockers.push('email_unverified');
  if (now.getTime() - facts.createdAt.getTime() < DAY_MS) blockers.push('too_young');
  return blockers.length === 0
    ? { promote: true, reason: 'auto:settled_card_24h' }
    : { promote: false, blockers };
}

export async function gatherPromotionFacts(partnerId: string): Promise<PromotionFacts> {
  const localFacts = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [[partner], deviceRows, [alertRow]] = await Promise.all([
      db.select({
        createdAt: partners.createdAt,
        emailVerifiedAt: partners.emailVerifiedAt,
        signupIpClass: partners.signupIpClass,
      }).from(partners).where(eq(partners.id, partnerId)).limit(1),
      db.select({ ipClass: devices.enrollmentIpClass }).from(devices)
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(eq(organizations.partnerId, partnerId)),
      db.select({ count: sql<number>`count(*)::int` }).from(partnerAbuseSignals).where(and(
        eq(partnerAbuseSignals.partnerId, partnerId),
        eq(partnerAbuseSignals.severity, 'alert'),
        isNull(partnerAbuseSignals.resolvedAt),
      )),
    ]);
    if (!partner) throw new Error(`Partner ${partnerId} not found`);
    return {
      createdAt: partner.createdAt,
      emailVerified: partner.emailVerifiedAt !== null,
      signupIpClass: partner.signupIpClass,
      deviceIpClasses: deviceRows.map((row) => row.ipClass),
      unresolvedAlerts: alertRow?.count ?? 0,
    };
  }, 'partnerTrustPromotion.gather'));

  const billing = getBreezeBillingClient();
  const [settledCard, hold] = await Promise.all([
    billing.getSettledCardCharge(partnerId),
    billing.getSignupRiskHold(partnerId),
  ]);
  // getSignupRiskHold returning null means we couldn't determine the
  // risk-hold status (404 from breeze-billing, or the request itself
  // failed) — NOT that the partner is clear. Fail closed: treat an unknown
  // status as a hold so an outage in breeze-billing can never silently
  // unblock an auto-promotion.
  const billingHoldUnknown = hold === null;
  // 'none' (no records / nothing open) and 'pass' (an unreleased row that
  // explicitly cleared the partner) are the only statuses that are not a hold.
  const billingHold = billingHoldUnknown
    ? true
    : hold.status !== 'none' && hold.status !== 'pass';
  return {
    ...localFacts,
    settledCard: settledCard && !settledCard.disputed && !settledCard.refunded
      && settledCard.paymentMethodType === 'card' && settledCard.threeDsAuthenticated
      && (settledCard.cardholderName ?? '').trim() !== ''
      ? { chargeId: settledCard.chargeId, settledAt: settledCard.settledAt }
      : null,
    billingHold,
    billingHoldUnknown,
  };
}

/**
 * Asks the billing service to expire the newly restricted partner's open
 * checkouts and cancel any incomplete subscription, then records the outcome
 * as its own audit row (`partner.trust.checkouts_closed`) next to the
 * restriction's. A separate row rather than more evidence on the restriction
 * row: the restriction is written first and must never wait on, or be undone
 * by, the billing service. Best effort throughout — never throws.
 *
 * Only in `enforce` mode. In `shadow` the restriction is recorded but no gate
 * acts on it, and expiring a checkout or canceling a subscription is a real,
 * external effect that promote-with-override does not undo.
 *
 * Nothing retries a close that did not happen (the partner is no longer on
 * probation, so it is never evaluated again), so a non-`closed` outcome is
 * sent to the ops channel for a human to finish by hand.
 */
async function closeOpenCheckoutsAfterRestrict(partnerId: string, reason: string): Promise<void> {
  if (partnerTrustMode() !== 'enforce') {
    console.info(
      `[partnerTrustPromotion] Not closing checkouts for restricted partner ${partnerId}: partner trust is not enforcing`,
    );
    return;
  }
  let outcome: CloseOpenCheckoutsResult;
  try {
    outcome = await getBreezeBillingClient().closeOpenCheckouts({ partnerId, reason });
  } catch (error) {
    // getBreezeBillingClient throws when billing is not configured; the
    // closeOpenCheckouts method itself never throws.
    outcome = { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
  // createAuditLogAsync never throws: a failed first write goes to the audit
  // retry queue, which reports to Sentry if the entry is finally dropped.
  await createAuditLogAsync({
    orgId: null,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action: 'partner.trust.checkouts_closed',
    resourceType: 'partner',
    resourceId: partnerId,
    result: outcome.status === 'closed' ? 'success' : 'failure',
    details: { trigger: reason, ...outcome },
  });
  if (outcome.status === 'closed') return;

  console.warn(
    `[partnerTrustPromotion] Could not close open checkouts for restricted partner ${partnerId}: ${outcome.status} (${outcome.detail})`,
  );
  // 'unavailable' is a deployment state (billing has no endpoint yet), not a
  // fault, so only 'failed' becomes a Sentry event; both page the ops channel.
  if (outcome.status === 'failed') {
    captureException(new Error(
      `[partnerTrustPromotion] close-open-checkouts failed for partner ${partnerId}: ${outcome.detail}`,
    ));
  }
  try {
    await sendOpsAlert({
      title: 'Auto-restricted partner: open checkouts not closed',
      body: [
        `Partner id: ${partnerId}`,
        `Restriction: ${reason}`,
        `Billing outcome: ${outcome.status} (${outcome.detail})`,
        'The partner is restricted, but its open checkout sessions and any incomplete subscription were NOT closed and nothing will retry. Close them by hand.',
      ].join('\n'),
    });
  } catch (error) {
    console.warn(`[partnerTrustPromotion] Failed to send checkout-close alert for partner ${partnerId}`, error);
  }
}

/**
 * Evaluates hard-deny signals and, when one matches, moves the partner to
 * `restricted` (CAS from `probation`), closes its open checkouts, and
 * best-effort sends the evidence card. Returns whether the restriction
 * actually landed.
 *
 * Checkouts are closed only when this call's CAS won, so they are closed once
 * per probation → restricted transition and never for a partner an admin (or a
 * concurrent evaluation) already moved. An admin lifts a restriction with the
 * existing promote-with-override (to `trusted`, which no hard-deny axis
 * evaluates); that does not restore anything closed here, so the partner
 * starts a new checkout.
 *
 * Lives here rather than in the job so that EVERY promotion path goes through
 * it — `tryAutoPromote` calls it first, so no caller can promote a partner
 * that should have been restricted. The ip-classify job still calls it
 * directly, since that path restricts without attempting a promotion.
 */
export async function restrictOnHardDeny(partnerId: string): Promise<boolean> {
  const decision = await evaluateHardDenies(partnerId);
  if (!decision.restrict) return false;
  const restricted = await setTrustState(
    partnerId,
    'restricted',
    decision.reason,
    null,
    decision.evidence,
    { expectedFrom: 'probation' },
  );
  if (restricted) {
    // Before the evidence card: an open checkout is where a card tester keeps
    // trying cards, so closing it is the time-critical effect (bounded by the
    // billing client's timeout).
    await closeOpenCheckoutsAfterRestrict(partnerId, decision.reason);
    try {
      await sendEvidenceCard(partnerId, 'restricted');
    } catch (error) {
      // Best-effort: the restriction itself already landed — a notification
      // failure must never surface as a job failure.
      console.warn(
        `[partnerTrustPromotion] Failed to send evidence card for restricted partner ${partnerId}`,
        error,
      );
    }
  }
  return restricted;
}

export async function tryAutoPromote(partnerId: string): Promise<boolean> {
  const current = await readTrust(partnerId);
  if (current?.trustState !== 'probation') return false;
  // Hard denies are evaluated here, not at the call site, so a direct caller
  // can never promote past a signal that should restrict. A failure to
  // evaluate them propagates rather than falling through to promotion.
  if (await restrictOnHardDeny(partnerId)) return false;
  const facts = await gatherPromotionFacts(partnerId);
  const decision = promotionDecision(facts, new Date());
  if (!decision.promote) return false;
  // setTrustState's writeTrust performs the actual UPDATE under
  // `AND trust_state = 'probation'` (expectedFrom), so this is an atomic
  // compare-and-swap: an admin restriction (or a second, concurrent
  // auto-promote) that lands between the reads above and this write causes
  // the CAS to affect zero rows. setTrustState returns false in that case
  // with no audit row and no Redis publish, which we surface as "not
  // promoted" rather than treating it as success.
  return setTrustState(partnerId, 'trusted', decision.reason, null, { ...facts }, { expectedFrom: 'probation' });
}
