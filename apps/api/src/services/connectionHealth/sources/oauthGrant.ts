import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation, HealthSource } from '../types';

const LOOKBACK_DAYS = 30;
// The only automatic revocation W1 reports. `provider-revoke-grant` is also
// what deliberate RP-initiated revocation and end_session write (oidc-provider's
// default revokeGrantPolicy), so it cannot tell a logout from a break. Code
// replay gets its own revocation reason in W4.
// Inlined as a literal, not bound: the planner must see it to match the
// partial index predicate.
const AUTO_REASON = sql.raw(`'refresh-token-reuse'`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_MAX = 80;

// DCR client_name is attacker-controlled. C0/C1 controls and line separators
// become spaces; bidi controls, zero-width characters and the BOM are removed,
// so a name cannot reorder or hide text in a notice. Then whitespace collapses
// and the result is capped in code points, never splitting a surrogate pair.
const TO_SPACE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
export function cleanDisplayName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string'
    ? raw.replace(TO_SPACE_RE, ' ').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim()
    : '';
  return Array.from(s || fallback).slice(0, DISPLAY_NAME_MAX).join('');
}

type PairRow = {
  account_id: string; client_id: string; partner_id: string; org_id: string | null;
  auto_revoked_at: Date | string | null; has_later: boolean; has_active: boolean;
  client_disabled: boolean; client_name: unknown;
};

/**
 * Spec §3 classification of one (account, client) pair. E is the pair's latest
 * automatic revoke inside the lookback. With E, only grants created after it
 * count: an active one → healthy; some but none active → retired (re-consent,
 * then a deliberate revoke or expiry); none → broken. Without E: active →
 * healthy, else retired. A disabled client is always retired.
 */
function toObservation(r: PairRow, now: Date): HealthObservation {
  const hasAutoRevoke = r.auto_revoked_at !== null;
  let state: HealthObservation['state'];
  if (r.client_disabled) state = 'retired';
  else if (r.has_active) state = 'healthy';
  else if (hasAutoRevoke && !r.has_later) state = 'broken';
  else state = 'retired';
  return {
    sourceKind: 'oauth_grant',
    sourceId: `${r.account_id}:${r.client_id}`,
    partnerId: r.partner_id,
    orgId: r.org_id,
    ownerUserId: r.account_id,
    state,
    severity: 'permanent',
    condition: hasAutoRevoke ? 'grant_revoked_reuse' : 'grant_revoked',
    detail: null,
    displayName: cleanDisplayName(r.client_name, r.client_id),
    fixHref: '/settings/connected-apps',
    ownerFixHref: '/account/connected-apps',
    viewPermission: PERMISSIONS.CONNECTED_APPS_READ,
    repairPermission: PERMISSIONS.CONNECTED_APPS_MANAGE,
    observedAt: now,
  };
}

const lookbackCutoff = (now: Date) => new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();

/**
 * Pairs with an automatically revoked grant inside the lookback. The WHERE
 * implies oauth_grants_auto_revoked_idx's predicate so the planner can use it;
 * partner_id is filtered later, in pairQuery, so it cannot steer the planner
 * onto oauth_grants_partner_idx.
 * Dates are bound as ISO strings (postgres-js cannot infer raw Date bindings).
 */
export function brokenCandidatesQuery(now: Date): SQL {
  return sql`
    SELECT DISTINCT account_id, client_id FROM oauth_grants
    WHERE revoked_reason = ${AUTO_REASON}
      AND revoked_by_user_id IS NULL
      AND revoked_at >= ${lookbackCutoff(now)}::timestamptz`;
}

/**
 * One row per pair in `pairs` that has a partner-attributed grant. Grants with
 * partner_id NULL are ignored throughout. Attribution comes from E's grant when
 * E exists, else from the newest grant. Every "latest" is fully ordered
 * (revoked_at, created_at, id) so ties cannot flap between runs.
 */
function pairQuery(pairsSql: SQL, now: Date): SQL {
  const nowIso = now.toISOString();
  return sql`
  WITH pairs(account_id, client_id) AS (${pairsSql}),
  grants AS (
    SELECT g.id, g.account_id, g.client_id, g.partner_id, g.org_id, g.created_at, g.expires_at,
      g.revoked_at, g.revoked_reason, g.revoked_by_user_id
    FROM oauth_grants g JOIN pairs p ON p.account_id = g.account_id AND p.client_id = g.client_id
    WHERE g.partner_id IS NOT NULL
  ),
  auto AS (
    SELECT DISTINCT ON (account_id, client_id) id, account_id, client_id, partner_id, org_id, revoked_at
    FROM grants
    WHERE revoked_reason = ${AUTO_REASON} AND revoked_by_user_id IS NULL
      AND revoked_at >= ${lookbackCutoff(now)}::timestamptz
    ORDER BY account_id, client_id, revoked_at DESC, created_at DESC, id DESC
  ),
  newest AS (
    SELECT DISTINCT ON (account_id, client_id) account_id, client_id, partner_id, org_id
    FROM grants
    ORDER BY account_id, client_id, created_at DESC, id DESC
  )
  SELECT n.account_id, n.client_id,
    CASE WHEN e.account_id IS NULL THEN n.partner_id ELSE e.partner_id END AS partner_id,
    CASE WHEN e.account_id IS NULL THEN n.org_id ELSE e.org_id END AS org_id,
    e.revoked_at AS auto_revoked_at,
    EXISTS (SELECT 1 FROM grants l WHERE l.account_id = n.account_id AND l.client_id = n.client_id
            AND l.id <> e.id AND l.created_at > e.revoked_at) AS has_later,
    EXISTS (SELECT 1 FROM grants a WHERE a.account_id = n.account_id AND a.client_id = n.client_id
            AND a.revoked_at IS NULL AND a.expires_at > ${nowIso}::timestamptz
            AND (e.id IS NULL OR (a.id <> e.id AND a.created_at > e.revoked_at))) AS has_active,
    (c.disabled_at IS NOT NULL) AS client_disabled,
    c.metadata->'client_name' AS client_name
  FROM newest n
  LEFT JOIN auto e ON e.account_id = n.account_id AND e.client_id = n.client_id
  LEFT JOIN oauth_clients c ON c.id = n.client_id`;
}

export const oauthGrantSource: HealthSource = {
  kind: 'oauth_grant',
  intervalMinutes: 15,
  async observe(now, trackedSourceIds) {
    // Tracked pairs, validated before any cast; malformed ids are skipped
    // (absent => the reconciler retires them).
    const tracked: Array<[string, string]> = [];
    for (const id of trackedSourceIds) {
      const i = id.indexOf(':');
      const acct = i > 0 ? id.slice(0, i) : '';
      if (UUID_RE.test(acct) && i < id.length - 1) tracked.push([acct, id.slice(i + 1)]);
    }
    const trackedValues = tracked.length
      ? sql`SELECT * FROM (VALUES ${sql.join(tracked.map(([a, c]) => sql`(${a}::uuid, ${c}::text)`), sql`, `)}) AS t(account_id, client_id)`
      : sql`SELECT NULL::uuid, NULL::text WHERE false`;
    const rows = (await db.execute(
      pairQuery(sql`${brokenCandidatesQuery(now)} UNION ${trackedValues}`, now),
    )) as unknown as PairRow[];

    const trackedSet = new Set(trackedSourceIds);
    const out: HealthObservation[] = [];
    for (const r of rows) {
      const o = toObservation(r, now);
      // Untracked pairs only matter when broken (spec §1.3: never report the healthy set).
      if (o.state === 'broken' || trackedSet.has(o.sourceId)) out.push(o);
    }
    return out;
  },
};
