/**
 * #11426 — the same-org rollup of device concerns.
 *
 * "Eight Toothzone devices each have their own LOW concern with the same
 * shape." The assessment raises one concern per device (one live concern per
 * subject), so a problem shared by a fleet stays N rows and buries the HIGH
 * ones. This pass, run by the wake tick after the incident correlator, folds
 * them:
 *
 * - Each live device concern has a pattern: `evidence.pattern` (the model's
 *   `record_concern.pattern`, normalised; assessmentFinalizer stamps it) or,
 *   when there is none (every device concern raised before #11426), the
 *   normalised first clause of its summary with the device's own names and
 *   every number-bearing token stripped (`fallbackConcernPattern`).
 * - ≥ ROLLUP_MIN_CHILDREN live device concerns of ONE org sharing a pattern
 *   become one org-level parent: severity = the max of the live children,
 *   summary "N devices: <pattern>", `child_concern_ids` = the children,
 *   signature `<orgId>:<pattern>` (one live parent per org + pattern, by the
 *   live-signature index). Never across orgs: the cross-org correlator
 *   (incidentCorrelator.ts) is a different pass and is not touched.
 * - The parent's subject is `incident` with a fresh id — never the org's
 *   own (org, <org id>) slot, which belongs to a real org-level concern
 *   (#10386; that slot holds ONE live concern, so a rollup there would also
 *   swallow later org-level raises). `incident` "names the concern itself":
 *   the reaper never reconciles it, and the ticket poller / correlator ignore
 *   it (no `evidence.tokens`, no `evidence.lastTicketAt`).
 * - A live parent follows its live members each tick: count and severity
 *   from them; children = the live members first, then the resolved ones it
 *   already held while room remains (ROLLUP_CHILD_CAP), and never a child
 *   that is live under another pattern now. It resolves with outcome
 *   `children_resolved` once no live device concern carries its pattern.
 *   When the child read hit its cap, "none this tick" is not proof, so a
 *   parent then closes only when SQL counts none of its stored children live.
 *   A parent a person closed (any other outcome) in the last
 *   CLOSED_SUPPRESSION_HOURS is not re-opened for the same signature.
 * - System-raised (`raised_by_grant_id` NULL) and never nudged: each child
 *   already carries its own nudge state.
 *
 * Reads run in system context; every write goes through concerns.ts, which
 * opens its own system context after the read block returned. No model call.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  CONCERN_SEVERITIES,
  normalizeConcernPattern,
  type ConcernSeverity,
  type ConcernSubject,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { captureException } from '../sentry';
import { resolveConcern, updateConcern, upsertConcern } from './concerns';
import { jsonRecord, stringArray } from './pollers';

export const ROLLUP_MIN_CHILDREN = 3;
export const ROLLUP_CHILD_CAP = 100;
/** `evidence.rollup` of a parent this pass made. */
export const CONCERN_ROLLUP_KIND = 'device_pattern';
/** The outcome a parent resolves with when its last child closed. */
export const CONCERN_ROLLUP_OUTCOME = 'children_resolved';

/** A person's close of a parent holds for this long against the same signature. */
const CLOSED_SUPPRESSION_HOURS = 24;
const CHILD_READ_LIMIT = 10_000;
const PARENT_READ_LIMIT = 2_000;
/** Words kept from a summary's first clause by the fallback pattern. */
const FALLBACK_WORDS = 8;
const HOUR_MS = 3_600_000;

type Result = { opened: number; updated: number; resolved: number };

type ChildRow = {
  id: string; partner_id: string; org_id: string; severity: string; summary: string;
  pattern: string | null; hostname: string | null; display_name: string | null;
};
type ParentRow = {
  id: string; partner_id: string; org_id: string; signature: string | null; status: string; outcome: string | null;
  summary: string; severity: string; evidence: unknown; child_concern_ids: unknown; live_children: number | string | null;
};

type Parent = {
  id: string; live: boolean; outcome: string | null; summary: string; severity: string;
  evidence: Record<string, unknown>; children: string[]; liveChildren: number;
};
type Group = { partnerId: string; orgId: string; pattern: string; ids: string[]; severity: ConcernSeverity };

/** Partner + signature: the live-signature index's own key. */
const groupKey = (partnerId: string, signature: string) => `${partnerId}|${signature}`;

function inSystemRead<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export function rollupSignature(orgId: string, pattern: string): string {
  return `${orgId}:${pattern}`;
}

/** A parent this pass made (the brief folds its children under it). */
export function isConcernRollup(c: { orgId: string | null; subject: ConcernSubject; evidence: Record<string, unknown> | null | undefined }): boolean {
  return c.orgId !== null && c.subject.kind === 'incident' && c.evidence?.rollup === CONCERN_ROLLUP_KIND;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The pattern of a device concern without one: its summary's first clause,
 * lowercased, with the device's names and every token that carries a digit
 * (versions, counts, CVE / KB ids, numbered hostnames) removed. null when too
 * little is left to group on.
 */
export function fallbackConcernPattern(summary: string, names: ReadonlyArray<string | null | undefined>): string | null {
  let s = ` ${summary.replace(/\s+/g, ' ')} `;
  for (const name of [...new Set(names.map((n) => n?.trim()).filter((n): n is string => Boolean(n)))].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRe(name)}(?=$|[^\\p{L}\\p{N}_-])`, 'giu'), '$1 ');
  }
  // First clause BEFORE dropping number tokens: `(CVE-2026-1234).` carries the sentence break.
  const clause = s.replace(/^[\s\p{P}]+/u, '').split(/[.!?](?=\s|$)|[;(]|,\s|\s[–—-]\s/u)[0] ?? '';
  const words = clause.replace(/\S*\d\S*/g, ' ').toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u).filter(Boolean).slice(0, FALLBACK_WORDS);
  return normalizeConcernPattern(words.join('_'));
}

const severityRank = (s: string) => CONCERN_SEVERITIES.indexOf(s as ConcernSeverity);
function maxSeverity(list: string[]): ConcernSeverity {
  let best: ConcernSeverity = 'info';
  for (const s of list) if (severityRank(s) > severityRank(best)) best = s as ConcernSeverity;
  return best;
}

function rollupSummary(count: number, pattern: string): string {
  return `${count} device${count === 1 ? '' : 's'}: ${pattern.replace(/_/g, ' ')}`;
}

function toParent(r: ParentRow): Parent {
  return {
    id: r.id,
    live: r.status === 'open' || r.status === 'snoozed',
    outcome: r.outcome,
    summary: r.summary,
    severity: r.severity,
    evidence: jsonRecord(r.evidence),
    children: stringArray(r.child_concern_ids),
    liveChildren: Number(r.live_children ?? 0),
  };
}

function groupChildren(rows: ChildRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const pattern = normalizeConcernPattern(r.pattern) ?? fallbackConcernPattern(r.summary, [r.hostname, r.display_name]);
    if (!pattern) continue;
    const key = groupKey(r.partner_id, rollupSignature(r.org_id, pattern));
    const g = groups.get(key) ?? { partnerId: r.partner_id, orgId: r.org_id, pattern, ids: [], severity: 'info' };
    g.ids.push(r.id);
    g.severity = maxSeverity([g.severity, r.severity]);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.ids.sort();
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
};

/**
 * Follow a live parent to this tick's live members. `liveGroupOf` maps each
 * live device concern read this tick to its group key: a stored child live
 * under ANOTHER pattern now leaves this parent; one not live (resolved) stays
 * as history while room remains. Deterministic (members sorted, history in
 * stored order), so a settled parent is not rewritten. False when nothing changed.
 */
async function refreshParent(p: Parent, g: Group, liveGroupOf: ReadonlyMap<string, string>): Promise<boolean> {
  const members = new Set(g.ids);
  const history = p.children.filter((id) => !members.has(id) && !liveGroupOf.has(id));
  const children = [...g.ids, ...history].slice(0, ROLLUP_CHILD_CAP);
  const summary = rollupSummary(g.ids.length, g.pattern);
  const evidence = { ...p.evidence, rollup: CONCERN_ROLLUP_KIND, pattern: g.pattern, deviceCount: g.ids.length };
  if (sameSet(children, p.children) && summary === p.summary && g.severity === p.severity && p.evidence.deviceCount === g.ids.length) {
    return false;
  }
  await updateConcern(p.id, { summary, severity: g.severity, childConcernIds: children, evidence });
  p.children = children;
  p.summary = summary;
  p.severity = g.severity;
  p.evidence = evidence;
  return true;
}

export async function rollupDeviceConcerns(now: Date): Promise<Result> {
  const out: Result = { opened: 0, updated: 0, resolved: 0 };
  if (!wispEnabled()) return out;
  const closedSince = new Date(now.getTime() - CLOSED_SUPPRESSION_HOURS * HOUR_MS).toISOString();

  const { childRows, parentRows } = await inSystemRead(async () => {
    // The devices join only reads the subject device's own names, to strip
    // them from a summary (fallbackConcernPattern); org-pinned, nothing else.
    const childRows = (await db.execute(sql`
      /* wisp:rollup-children */
      SELECT c.id, c.partner_id, c.org_id, c.severity, c.summary, c.evidence->>'pattern' AS pattern,
             d.hostname, d.display_name
        FROM wisp_concerns c
        LEFT JOIN devices d ON d.id = c.subject_id AND d.org_id = c.org_id
       WHERE c.subject_kind = 'device'
         AND c.org_id IS NOT NULL
         AND c.status IN ('open', 'snoozed')
       ORDER BY c.partner_id, c.org_id, c.id
       LIMIT ${CHILD_READ_LIMIT}`)) as unknown as ChildRow[];
    const parentRows = (await db.execute(sql`
      /* wisp:rollup-parents */
      SELECT c.id, c.partner_id, c.org_id, c.signature, c.status, c.outcome, c.summary, c.severity, c.evidence,
             to_jsonb(c.child_concern_ids) AS child_concern_ids,
             (SELECT count(*)::int FROM wisp_concerns ch
               WHERE ch.id = ANY(c.child_concern_ids)
                 AND ch.partner_id = c.partner_id
                 AND ch.status IN ('open', 'snoozed')) AS live_children
        FROM wisp_concerns c
       WHERE c.subject_kind = 'incident'
         AND c.org_id IS NOT NULL
         AND c.signature IS NOT NULL
         AND c.evidence->>'rollup' = ${CONCERN_ROLLUP_KIND}
         AND (c.status IN ('open', 'snoozed')
              OR (c.status IN ('resolved', 'dismissed') AND c.updated_at >= ${closedSince}::timestamptz))
       ORDER BY c.id
       LIMIT ${PARENT_READ_LIMIT}`)) as unknown as ParentRow[];
    return { childRows: [...childRows], parentRows: [...parentRows] };
  }, 'wisp-rollup-device-concerns');

  // Rows are ordered by partner, org: past the cap the same trailing orgs are
  // skipped on every tick, so this is an error, not a passing warning.
  const truncated = childRows.length >= CHILD_READ_LIMIT;
  if (truncated) {
    console.error(`[wisp/concernRollup] read the ${CHILD_READ_LIMIT}-row cap of live device concerns; the orgs past it are not rolled up`);
  }

  const groups = groupChildren(childRows);
  const liveGroupOf = new Map<string, string>();
  for (const g of groups) {
    const key = groupKey(g.partnerId, rollupSignature(g.orgId, g.pattern));
    for (const id of g.ids) liveGroupOf.set(id, key);
  }

  const live = new Map<string, Parent>();
  const suppressed = new Set<string>();
  for (const r of parentRows) {
    if (!r.signature) continue;
    const key = groupKey(r.partner_id, r.signature);
    const p = toParent(r);
    if (p.live) live.set(key, p);
    else if (p.outcome !== CONCERN_ROLLUP_OUTCOME) suppressed.add(key);
  }

  const seen = new Set<string>();
  for (const g of groups) {
    const signature = rollupSignature(g.orgId, g.pattern);
    const key = groupKey(g.partnerId, signature);
    seen.add(key);
    try {
      const existing = live.get(key);
      if (existing) {
        if (await refreshParent(existing, g, liveGroupOf)) out.updated += 1;
        continue;
      }
      if (g.ids.length < ROLLUP_MIN_CHILDREN || suppressed.has(key)) continue;
      const evidence = { rollup: CONCERN_ROLLUP_KIND, pattern: g.pattern, deviceCount: g.ids.length };
      const childConcernIds = g.ids.slice(0, ROLLUP_CHILD_CAP);
      const summary = rollupSummary(g.ids.length, g.pattern);
      const { id, created } = await upsertConcern({
        partnerId: g.partnerId,
        orgId: g.orgId,
        subject: { kind: 'incident', id: randomUUID() },
        signature,
        severity: g.severity,
        summary,
        evidence,
        childConcernIds,
      });
      if (created) {
        out.opened += 1;
        live.set(key, { id, live: true, outcome: null, summary, severity: g.severity, evidence, children: childConcernIds, liveChildren: g.ids.length });
        continue;
      }
      // Lost the signature race (another tick, or a parent past the read cap):
      // follow the winner. Its stored state is unknown, so write it whole.
      const winner: Parent = { id, live: true, outcome: null, summary: '', severity: '', evidence: {}, children: [], liveChildren: 0 };
      live.set(key, winner);
      if (await refreshParent(winner, g, liveGroupOf)) out.updated += 1;
    } catch (err) {
      // Sentry tags are allowlisted and bounded (sentry.ts): the ids go to the log.
      console.warn('[wisp/concernRollup] rollup of one pattern failed; the next tick retries', { orgId: g.orgId, signature, error: err });
      captureException(err, undefined, { component: 'wisp.concernRollup', op: 'rollup' });
    }
  }

  // A live parent whose pattern no live device concern carries any more closes
  // itself (its children resolved, or moved to another pattern). After a
  // capped read "unseen" is not proof: then it closes only when SQL counts
  // none of its stored children live.
  for (const [key, p] of live) {
    if (seen.has(key) || (truncated && p.liveChildren > 0)) continue;
    try {
      const { resolved } = await resolveConcern(p.id, {}, CONCERN_ROLLUP_OUTCOME);
      if (resolved) out.resolved += 1;
    } catch (err) {
      console.warn('[wisp/concernRollup] closing a rollup parent failed; the next tick retries', { concernId: p.id, error: err });
      captureException(err, undefined, { component: 'wisp.concernRollup', op: 'resolve' });
    }
  }
  return out;
}
