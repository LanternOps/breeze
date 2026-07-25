import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

// ---------------------------------------------------------------------------
// Billing-identity detector: billing.cardholder_name_mismatch /
// billing.shared_card_fingerprint / billing.card_testing
//
// Contract (same as heuristics.ts and scriptContent.ts):
// loadBillingIdentityAggregates() does bounded SQL, computeBillingIdentitySignals()
// is pure and unit-tested.
//
// The partners.billing_* columns this reads are written EXCLUSIVELY by the
// separate billing service from its payment-provider webhooks. Nothing here
// calls a payment provider: the sweep runs hourly and must never depend on an
// external API being up, nor leak sweep cadence to the provider.
//
// NEVER age-decayed (the pure scorer deliberately never sees partnerCreatedAt
// or youngWeight()) — a cardholder name that matches nothing about the account
// is evidence regardless of account age, same rationale as
// fraud.failed_login_cluster and the script-content markers.
//
// Cross-tenant corpus rule (mirrors rmm.shared_installer_host): fingerprints
// are correlated over ALL partners regardless of status — a suspended partner
// must stay in the corpus or the re-signup it is correlated with goes unseen —
// but signals are only attributed to active, non-deleted partners.
//
// Coverage caveat: wallet/Link-style payments expose no card fingerprint, so
// billing_card_fingerprint is frequently NULL. NULL is "unknown" and can never
// match another NULL; name matching is the primary signal.
// ---------------------------------------------------------------------------

export interface BillingIdentityAggregate {
  partnerId: string;
  partnerName: string;
  /** Partner billing email + member emails (bounded). Used for local-part and domain tokens. */
  emails: string[];
  /** Member display names (bounded). */
  userNames: string[];
  /** Name on the payment instrument, as reported by the billing service. */
  cardholderName: string | null;
  /** Provider-side opaque card fingerprint; NULL for wallet/Link payments. */
  cardFingerprint: string | null;
  distinctPaymentMethods: number;
  /**
   * Bounds of the interval distinctPaymentMethods was accumulated over.
   * billing.card_testing scores the SPAN between them — three cards seven
   * minutes apart and three cards two years apart are the same count and
   * completely different events. Either being NULL means the span is unknown,
   * which must fail closed rather than read as a zero span.
   */
  paymentMethodsFirstSeenAt: Date | null;
  paymentMethodsLastSeenAt: Date | null;
  failedAttempts: number;
  /**
   * When the billing service last refreshed this snapshot. Carried into
   * card-testing evidence for triage; deliberately gates nothing — snapshot
   * recency is not the same question as the accumulation span.
   */
  identitySyncedAt: Date | null;
}

export interface BillingIdentityResult {
  /** Aggregates for partners in the evaluated (active, non-deleted) scope only. */
  aggregates: BillingIdentityAggregate[];
  /** fingerprint -> distinct partner count (>= 2), computed over the FULL corpus. */
  sharedFingerprints: Map<string, number>;
  /** Partner ids scored this sweep — fed into evaluatedPartnerIds so open rows stale-resolve. */
  scannedPartnerIds: string[];
}

// ---------------------------------------------------------------------------
// Matching algorithm (pure)
// ---------------------------------------------------------------------------

/** Tokens shorter than this are noise (initials, "of", "&"). */
const MIN_TOKEN_LENGTH = 3;

/**
 * Letters that do not decompose under NFKD, so the combining-mark strip below
 * cannot fold them. Without these, e.g. a Nordic "ø" spelling and its "o"
 * spelling tokenize differently and read as a mismatch.
 */
const NON_DECOMPOSING_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'o'],
  [/đ|ð/g, 'd'],
  [/ł/g, 'l'],
  [/þ/g, 'th'],
  [/ı/g, 'i'],
];

/**
 * Tokens that carry no identity: corporate suffixes and industry filler. A
 * partner named "<something> IT Solutions" and a cardholder named
 * "<someone else> Solutions" share nothing meaningful, and letting "solutions"
 * count as a match would silently disable the signal for most MSP names.
 */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  'and', 'the', 'for', 'llc', 'inc', 'ltd', 'limited', 'corp', 'corporation',
  'company', 'holdings', 'holding', 'group', 'groupe', 'gmbh', 'bhd', 'pty',
  'plc', 'sarl', 'srl', 'spa', 'oyj', 'aps',
  'services', 'service', 'solutions', 'solution', 'systems', 'system',
  'technologies', 'technology', 'tech', 'consulting', 'consultants',
  'consultant', 'partners', 'partner', 'managed', 'management',
  'computer', 'computers', 'computing', 'network', 'networks', 'networking',
  'support', 'helpdesk', 'digital', 'data', 'cloud', 'cyber', 'global',
  'international', 'enterprises', 'enterprise', 'associates', 'agency',
  'studio', 'studios', 'labs', 'works', 'online', 'internet', 'software',
  'info', 'admin', 'billing', 'accounts', 'accounting', 'finance', 'office',
  'mail', 'email', 'contact', 'hello', 'sales', 'team',
]);

/**
 * Second-level labels that are public suffixes rather than the registrable
 * name, so `<name>.co.uk` resolves its base label to `<name>`, not `co`.
 */
const PUBLIC_SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go',
]);

/**
 * Free/consumer mailbox providers, matched on the registrable base label so
 * ccTLD variants (yahoo.co.uk, gmx.de) fold to the same entry.
 *
 * These contribute NO domain token. Without the exclusion, a partner on a
 * consumer mailbox would have "gmail" in its identity token set — a token no
 * cardholder name ever contains, so every such account would fire on the
 * domain axis and the signal would teach nothing. Not sensitive; deliberately
 * in code rather than an env indicator list.
 */
export const FREE_EMAIL_PROVIDER_LABELS: ReadonlySet<string> = new Set([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'passport',
  'yahoo', 'ymail', 'rocketmail', 'aol', 'aim', 'proton', 'protonmail',
  'icloud', 'mac', 'gmx', 'web', 'mail', 'email', 'inbox', 'yandex',
  'zoho', 'fastmail', 'hey', 'tutanota', 'tuta', 'hushmail',
  'qq', 'naver', 'daum', 'hanmail', 'seznam', 'libero', 'orange', 'free',
  'wanadoo', 'laposte', 'sfr', 'bol', 'uol', 'terra', 'rediffmail', 'sina',
  'comcast', 'verizon', 'sbcglobal', 'bellsouth', 'earthlink', 'juno',
  'btinternet', 'virginmedia', 'talktalk', 'ntlworld', 'blueyonder',
  'bigpond', 'optusnet', 'xtra', 'shaw', 'telus', 'rogers', 'sympatico',
  'mailinator', 'guerrillamail', 'yopmail', 'maildrop', 'dispostable',
  'sharklasers', 'trashmail', 'getnada', 'fakeinbox',
]);

/** Lowercase, fold diacritics and non-decomposing letters. Pure; exported for tests. */
export function normalizeIdentityText(value: string): string {
  let out = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [pattern, replacement] of NON_DECOMPOSING_FOLDS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Order-independent token set: normalize, split on punctuation, drop digits
 * (a mailbox `<name>91` is still that name), drop short tokens and stop words.
 */
export function identityTokens(value: string): string[] {
  return normalizeIdentityText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.replace(/[0-9]+/g, ''))
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_TOKENS.has(token));
}

const emailLocalPart = (email: string): string | null => {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : null;
};

const emailDomain = (email: string): string | null => {
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at + 1).toLowerCase().trim() : '';
  return domain.length > 0 ? domain : null;
};

/** Domain labels that carry identity: everything left of the TLD (and of a public 2LD suffix). */
export function domainIdentityLabels(domain: string): string[] {
  const labels = domain.toLowerCase().split('.').filter((label) => label.length > 0);
  if (labels.length < 2) return [];
  let end = labels.length - 1; // drop the TLD label
  const secondLevel = labels[end - 1];
  if (end >= 1 && secondLevel !== undefined && PUBLIC_SECOND_LEVEL_LABELS.has(secondLevel)) end -= 1;
  return labels.slice(0, end);
}

/** True when the mailbox domain is a free/consumer provider (base-label match). */
export function isFreeEmailProvider(domain: string, freeLabels: ReadonlySet<string>): boolean {
  const labels = domainIdentityLabels(domain);
  const base = labels[labels.length - 1];
  return base !== undefined && freeLabels.has(base);
}

/**
 * The account's identity token set: partner name, every member's display name,
 * every mailbox local-part, and — for non-free mailbox domains only — the
 * domain labels.
 */
export function buildIdentityTokens(
  aggregate: Pick<BillingIdentityAggregate, 'partnerName' | 'userNames' | 'emails'>,
  freeLabels: ReadonlySet<string> = FREE_EMAIL_PROVIDER_LABELS,
): Set<string> {
  const tokens = new Set<string>(identityTokens(aggregate.partnerName));
  for (const name of aggregate.userNames) {
    for (const token of identityTokens(name)) tokens.add(token);
  }
  for (const email of aggregate.emails) {
    const local = emailLocalPart(email);
    if (local) for (const token of identityTokens(local)) tokens.add(token);
    const domain = emailDomain(email);
    if (!domain || isFreeEmailProvider(domain, freeLabels)) continue;
    for (const label of domainIdentityLabels(domain)) {
      for (const token of identityTokens(label)) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Milliseconds between two snapshot bounds, or null when the span is unknown
 * (either bound missing) or incoherent (last before first). Null is never a
 * zero span — every caller must treat it as "do not fire".
 */
export function spanMilliseconds(first: Date | null, last: Date | null): number | null {
  if (first === null || last === null) return null;
  const span = last.getTime() - first.getTime();
  if (!Number.isFinite(span) || span < 0) return null;
  return span;
}

export interface BillingIdentityScorerOptions {
  /** Injectable for tests; defaults to FREE_EMAIL_PROVIDER_LABELS. */
  freeEmailProviderLabels?: ReadonlySet<string>;
}

/**
 * Pure scoring: no I/O, unit-testable. Emits per-partner:
 *   - billing.cardholder_name_mismatch — the cardholder name shares no
 *     meaningful token with the account identity.
 *   - billing.shared_card_fingerprint — the same non-null fingerprint appears
 *     under >= min_partners distinct partners in the corpus.
 *   - billing.card_testing — >= distinct_methods payment methods accumulated
 *     inside a span of <= window_days.
 *
 * Known miss, on purpose: a cardholder sharing a token with the partner name
 * never fires. Tightening that (e.g. requiring a PERSON-name match) starts
 * flagging every operator who pays with a spouse's or parent company's card,
 * which is common and legitimate.
 *
 * Takes no clock at all — not `now`, not partnerCreatedAt — which is what makes
 * "never age-decayed" structural rather than a convention, same as
 * computeScriptSignals.
 */
export function computeBillingIdentitySignals(
  aggregates: readonly BillingIdentityAggregate[],
  sharedFingerprints: ReadonlyMap<string, number>,
  cfg: SignalConfig,
  options: BillingIdentityScorerOptions = {},
): ComputedSignal[] {
  const freeLabels = options.freeEmailProviderLabels ?? FREE_EMAIL_PROVIDER_LABELS;
  const minPartners = cfg['billing.shared_card_fingerprint.min_partners'];
  const signals: ComputedSignal[] = [];

  for (const a of aggregates) {
    const push = (signalKey: string, rawScore: number, evidence: Record<string, unknown>) => {
      const score = Math.min(100, Math.round(rawScore));
      if (!(score > 0)) return;
      signals.push({
        partnerId: a.partnerId,
        signalKey,
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: { partnerName: a.partnerName, ...evidence },
      });
    };

    // --- billing.cardholder_name_mismatch ---------------------------------
    const cardholder = a.cardholderName?.trim() ?? '';
    if (cardholder.length > 0) {
      const cardholderSet = identityTokens(cardholder);
      const accountSet = buildIdentityTokens(a, freeLabels);
      // Both sides must be non-empty: an account whose every token was a stop
      // word has nothing to compare against, and "no data" is not evidence.
      const comparable = cardholderSet.length > 0 && accountSet.size > 0;
      if (comparable && !cardholderSet.some((token) => accountSet.has(token))) {
        push(
          'billing.cardholder_name_mismatch',
          cfg['billing.cardholder_name_mismatch.score'] +
            cfg['billing.cardholder_name_mismatch.failed_attempt_bonus'] * a.failedAttempts,
          {
            // The operator cannot triage a name mismatch without the name.
            cardholderName: cardholder,
            failedAttempts: a.failedAttempts,
          },
        );
      }
    }

    // --- billing.shared_card_fingerprint ----------------------------------
    // NULL/blank fingerprints are skipped outright: a wallet payment that
    // exposes no fingerprint must never correlate with another one.
    const fingerprint = a.cardFingerprint?.trim() ?? '';
    if (fingerprint.length > 0) {
      const partnerCount = sharedFingerprints.get(fingerprint) ?? 0;
      if (partnerCount >= minPartners) {
        push(
          'billing.shared_card_fingerprint',
          cfg['billing.shared_card_fingerprint.base_score'] +
            cfg['billing.shared_card_fingerprint.per_extra_partner'] * (partnerCount - minPartners),
          {
            // Prefix only — enough to join the affected partners together in a
            // follow-up query without pasting a full payment-instrument
            // identifier into a chat alert.
            cardFingerprintPrefix: fingerprint.slice(0, 12),
            partnerCount,
          },
        );
      }
    }

    // --- billing.card_testing ---------------------------------------------
    // N distinct payment methods accumulated INSIDE a short span. The span —
    // not the count, and not snapshot recency — is what separates a testing
    // burst from a long-lived account that has replaced an expired card a few
    // times: both show the same count, and both may have synced this morning.
    //
    // Fails closed on an unknown span. A NULL first/last-seen (legacy row, or
    // the billing service has not backfilled yet) is NOT a zero span; treating
    // it as one would fire for every pre-existing partner with 3+ lifetime
    // cards the moment this ships. Same for a reversed pair, which is bad data
    // rather than an instantaneous burst.
    const methodThreshold = cfg['billing.card_testing.distinct_methods'];
    const windowMs = cfg['billing.card_testing.window_days'] * 86_400_000;
    const spanMs = spanMilliseconds(a.paymentMethodsFirstSeenAt, a.paymentMethodsLastSeenAt);
    if (spanMs !== null && spanMs <= windowMs && a.distinctPaymentMethods >= methodThreshold) {
      push(
        'billing.card_testing',
        cfg['billing.card_testing.base_score'] +
          cfg['billing.card_testing.per_extra_method'] * (a.distinctPaymentMethods - methodThreshold) +
          cfg['billing.card_testing.per_failed_attempt'] * a.failedAttempts,
        {
          distinctPaymentMethods: a.distinctPaymentMethods,
          failedAttempts: a.failedAttempts,
          spanMinutes: Number((spanMs / 60_000).toFixed(1)),
          paymentMethodsFirstSeenAt: a.paymentMethodsFirstSeenAt?.toISOString() ?? null,
          paymentMethodsLastSeenAt: a.paymentMethodsLastSeenAt?.toISOString() ?? null,
          // Snapshot age answers the operator's first triage question: is this
          // burst happening now, or is it a stale row the billing service has
          // not touched in weeks? It gates nothing — only the span does.
          identitySyncedAt: a.identitySyncedAt?.toISOString() ?? null,
        },
      );
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Bound every text read; never pull unbounded fleet-wide text. */
const TEXT_CAP = 255;
const MEMBERS_PER_PARTNER_CAP = 50;

interface AggregateRow {
  id: string;
  name: string;
  billing_email: string | null;
  billing_cardholder_name: string | null;
  billing_card_fingerprint: string | null;
  billing_distinct_payment_methods: number | string | null;
  billing_payment_methods_first_seen_at: string | Date | null;
  billing_payment_methods_last_seen_at: string | Date | null;
  billing_failed_attempts: number | string | null;
  billing_identity_synced_at: string | Date | null;
  user_names: unknown;
  user_emails: unknown;
}

/** Parse a timestamptz column; an unparseable value is "unknown", never epoch. */
const toDate = (value: string | Date | null): Date | null => {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];

/**
 * Loads the billing-identity snapshot plus the cross-partner fingerprint
 * corpus. MUST run inside a system DB context — bare breeze_app reads return
 * 0 rows.
 */
export async function loadBillingIdentityAggregates(): Promise<BillingIdentityResult> {
  // --- 1. Fingerprint correlation over ALL partners (corpus rule) ----------
  // No status/deleted filter on purpose: a suspended partner must stay in the
  // corpus, otherwise the re-signup that reuses its card looks clean.
  const sharedRows = (await db.execute(sql`
    SELECT billing_card_fingerprint AS fingerprint, COUNT(DISTINCT id) AS partner_count
    FROM partners
    WHERE billing_card_fingerprint IS NOT NULL AND btrim(billing_card_fingerprint) <> ''
    GROUP BY billing_card_fingerprint
    HAVING COUNT(DISTINCT id) >= 2
  `)) as unknown as Array<{ fingerprint: string; partner_count: string }>;
  const sharedFingerprints = new Map(sharedRows.map((r) => [r.fingerprint, Number(r.partner_count)]));

  // --- 2. Aggregates for the evaluated scope only --------------------------
  const rows = (await db.execute(sql`
    WITH scoped AS (
      SELECT p.id, p.name, p.billing_email,
        p.billing_cardholder_name,
        p.billing_card_fingerprint,
        p.billing_distinct_payment_methods,
        p.billing_payment_methods_first_seen_at,
        p.billing_payment_methods_last_seen_at,
        p.billing_failed_attempts,
        p.billing_identity_synced_at
      FROM partners p
      WHERE p.deleted_at IS NULL AND p.status = 'active'
        AND (
          p.billing_cardholder_name IS NOT NULL
          OR p.billing_card_fingerprint IS NOT NULL
          OR p.billing_distinct_payment_methods > 0
          -- Keep re-evaluating partners with an open billing signal even after
          -- the billing service clears the snapshot, so the row resolves on
          -- evidence rather than being stranded open by scope exit.
          OR EXISTS (
            SELECT 1 FROM partner_abuse_signals pas
            WHERE pas.partner_id = p.id AND pas.resolved_at IS NULL
              AND pas.signal_key LIKE 'billing.%'
          )
        )
    ),
    members AS (
      SELECT partner_id, member_name, member_email FROM (
        SELECT u.partner_id,
          left(u.name, ${TEXT_CAP}) AS member_name,
          left(u.email, ${TEXT_CAP}) AS member_email,
          row_number() OVER (PARTITION BY u.partner_id ORDER BY u.created_at) AS rn
        FROM users u
        WHERE u.partner_id IN (SELECT id FROM scoped)
      ) bounded
      WHERE rn <= ${MEMBERS_PER_PARTNER_CAP}
    ),
    member_agg AS (
      SELECT partner_id,
        array_agg(member_name) AS user_names,
        array_agg(member_email) AS user_emails
      FROM members GROUP BY partner_id
    )
    SELECT s.id, s.name, s.billing_email,
      s.billing_cardholder_name,
      s.billing_card_fingerprint,
      s.billing_distinct_payment_methods,
      s.billing_payment_methods_first_seen_at,
      s.billing_payment_methods_last_seen_at,
      s.billing_failed_attempts,
      s.billing_identity_synced_at,
      COALESCE(m.user_names, '{}') AS user_names,
      COALESCE(m.user_emails, '{}') AS user_emails
    FROM scoped s
    LEFT JOIN member_agg m ON m.partner_id = s.id
  `)) as unknown as AggregateRow[];

  const aggregates: BillingIdentityAggregate[] = rows.map((r) => {
    const emails = [...(r.billing_email ? [r.billing_email] : []), ...stringArray(r.user_emails)];
    return {
      partnerId: String(r.id),
      partnerName: String(r.name),
      emails,
      userNames: stringArray(r.user_names),
      cardholderName: r.billing_cardholder_name,
      cardFingerprint: r.billing_card_fingerprint,
      distinctPaymentMethods: Number(r.billing_distinct_payment_methods ?? 0),
      paymentMethodsFirstSeenAt: toDate(r.billing_payment_methods_first_seen_at),
      paymentMethodsLastSeenAt: toDate(r.billing_payment_methods_last_seen_at),
      failedAttempts: Number(r.billing_failed_attempts ?? 0),
      identitySyncedAt: toDate(r.billing_identity_synced_at),
    };
  });

  return {
    aggregates,
    sharedFingerprints,
    scannedPartnerIds: [...new Set(aggregates.map((a) => a.partnerId))],
  };
}
