import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation, HealthSource } from '../types';

const LOOKBACK_DAYS = 30;
const AUTO_REASONS: Record<string, string> = {
  'refresh-token-reuse': 'grant_revoked_reuse',
  'provider-revoke-grant': 'grant_revoked_code_replay',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DCR client_name is attacker-controlled: strip control chars, collapse space, cap.
export function cleanDisplayName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, 80);
}

type PairRow = {
  account_id: string; client_id: string; partner_id: string | null; org_id: string | null;
  revoked_at: Date | string | null; revoked_reason: string | null; revoked_by_user_id: string | null;
  has_active: boolean; client_disabled: boolean; client_name: unknown;
};

function toObservation(r: PairRow, now: Date): HealthObservation | null {
  if (!r.partner_id) return null;
  const cutoff = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  const revokedAtMs = r.revoked_at ? new Date(r.revoked_at).getTime() : null;
  const condition = r.revoked_reason ? AUTO_REASONS[r.revoked_reason] : undefined;
  let state: HealthObservation['state'];
  if (r.client_disabled) state = 'retired';
  else if (r.has_active) state = 'healthy';
  else if (condition && !r.revoked_by_user_id && revokedAtMs !== null && revokedAtMs >= cutoff) state = 'broken';
  else state = 'retired';
  return {
    sourceKind: 'oauth_grant',
    sourceId: `${r.account_id}:${r.client_id}`,
    partnerId: r.partner_id,
    orgId: r.org_id,
    ownerUserId: r.account_id,
    state,
    severity: 'permanent',
    condition: condition ?? 'grant_revoked',
    detail: null,
    displayName: cleanDisplayName(r.client_name, r.client_id),
    fixHref: '/settings/connected-apps',
    ownerFixHref: '/account/connected-apps',
    viewPermission: PERMISSIONS.CONNECTED_APPS_READ,
    repairPermission: PERMISSIONS.CONNECTED_APPS_MANAGE,
    observedAt: now,
  };
}

/**
 * Pairs with an automatically revoked grant inside the lookback. The WHERE
 * implies oauth_grants_auto_revoked_idx's predicate so the planner can use it.
 * Dates are bound as ISO strings (postgres-js cannot infer raw Date bindings).
 */
export function brokenCandidatesQuery(now: Date): SQL {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  return sql`
    SELECT DISTINCT account_id, client_id FROM oauth_grants
    WHERE revoked_reason IN ('refresh-token-reuse','provider-revoke-grant')
      AND revoked_by_user_id IS NULL
      AND revoked_at >= ${cutoff}::timestamptz`;
}

// Newest grant per (account, client) among `pairs`, plus whether any grant is active.
function pairQuery(pairsSql: SQL, now: Date): SQL {
  return sql`
  WITH pairs(account_id, client_id) AS (${pairsSql}),
  newest AS (
    SELECT DISTINCT ON (g.account_id, g.client_id)
      g.account_id, g.client_id, g.partner_id, g.org_id, g.revoked_at, g.revoked_reason, g.revoked_by_user_id
    FROM oauth_grants g JOIN pairs p ON p.account_id = g.account_id AND p.client_id = g.client_id
    ORDER BY g.account_id, g.client_id, g.created_at DESC
  )
  SELECT n.*,
    EXISTS (SELECT 1 FROM oauth_grants a WHERE a.account_id = n.account_id AND a.client_id = n.client_id
            AND a.revoked_at IS NULL AND a.expires_at > ${now.toISOString()}::timestamptz) AS has_active,
    (c.disabled_at IS NOT NULL) AS client_disabled,
    c.metadata->'client_name' AS client_name
  FROM newest n LEFT JOIN oauth_clients c ON c.id = n.client_id`;
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
      if (o && (o.state === 'broken' || trackedSet.has(o.sourceId))) out.push(o);
    }
    return out;
  },
};
