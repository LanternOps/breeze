import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { isValidIanaTimezone, type ConfirmSuggestionInput } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../db';
import { timeSuggestionDecisions } from '../db/schema';
import {
  createTimeEntry, readTimeEntryById, resolveAndLockOrgLink,
  TimeEntryServiceError, type TimeEntryActor, type TimeEntryRow,
} from './timeEntryService';
import { getSessionSuggestionSettings, type SessionSuggestionSettings } from './timeSuggestionSettings';
import {
  alreadyLoggedVerdict, classifySignal, dayWindowUtc, envelopeOf, mergeSignals,
  rankTicketCandidates, suggestionKey, validateConfirmRange,
  UNRELIABLE_AFTER_MS, TICKET_WINDOW_BEFORE_MS, TICKET_WINDOW_AFTER_MS,
  type LoggedRange, type SignalPrecision, type SignalRow, type TicketCandidateRow,
} from './timeSuggestionRules';

export type SuggestionSignalRef = { kind: 'remote_session'; id: string };

export interface TimeSuggestionSignal {
  kind: 'remote_session';
  id: string;
  type: 'terminal' | 'desktop' | 'file_transfer';
  startedAt: string;
  endedAt: string;
  precision: SignalPrecision;
}

export interface TimeSuggestion {
  key: string;
  signals: TimeSuggestionSignal[];
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  device: { id: string; hostname: string } | null;
  org: { id: string; name: string } | null;
  quickSupport: { attributionLabel: string | null; attributedOrgName: string | null } | null;
  candidateTicket: { id: string; ticketNumber: string; subject: string; status: string; reason: 'closed_by_you' | 'assigned_to_you' } | null;
  otherTickets: Array<{ id: string; ticketNumber: string; subject: string }>;
  suggestedSource: 'remote_session' | 'support_session';
  /**
   * F19: minutes of this window already covered by the actor's existing
   * time_entries. 0 normally; > 0 means a partial overlap the sheet must show.
   * A window >= ALREADY_LOGGED_DROP_RATIO covered is dropped and never reaches
   * the client.
   */
  alreadyLoggedOverlapMinutes: number;
}

export interface ListSuggestionsResult {
  enabled: boolean;
  date: string;
  timezone: string;
  suggestions: TimeSuggestion[];
  unloggedCount: number;
}

export interface SuggestionActor extends TimeEntryActor {
  scope: 'partner' | 'system';
}

export interface LoadedSignal extends SignalRow {
  precision: SignalPrecision;
  orgId: string;
  orgName: string;
  orgType: string;
  deviceHostname: string | null;
  attributedOrgId: string | null;
  attributedOrgName: string | null;
  attributionLabel: string | null;
}

const MAX_LOOKBACK_DAYS = 31;

/**
 * ISO string for a naive-UTC `timestamp` comparison. remote_sessions.*_at and
 * time_entries.*_at are `timestamp` WITHOUT time zone written from a JS Date,
 * i.e. UTC wall-clock. The explicit `AT TIME ZONE 'UTC'` means no session
 * `TimeZone` setting can shift the day window.
 */
const utcTs = (d: Date) => sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * A `uuid[]` literal built from ONE bound parameter per element.
 *
 * NOT `ANY(${ids}::uuid[])`. Interpolating a JS array binds the WHOLE array as
 * a single parameter, and postgres.js then hands Postgres the bare element text
 * rather than a `{...}` array literal — `malformed array literal` (22P02) at
 * runtime, from a query that every mocked unit test accepts because no mock
 * ever serialises a parameter. This is the #2655 failure class; see the note on
 * `buildUnpromotedAdminMatch` in services/platformAdminBootstrap.ts. Caught here
 * by timeSuggestionDecisionsRls.integration.test.ts against real Postgres.
 *
 * An EMPTY list renders `ARRAY[]::uuid[]`, which matches nothing — exactly what
 * `accessibleOrgIds: []` (a partner user granted no orgs) must mean.
 */
const uuidArray = (ids: readonly string[]) =>
  ids.length === 0
    ? sql`ARRAY[]::uuid[]`
    : sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

/**
 * The one signal query (spec backend-flow step 3). Runs in the CALLER's DB
 * context — RLS on remote_sessions / organizations / devices / support_sessions
 * is the first wall; `rs.user_id = :user AND o.partner_id = :partner` and the
 * accessibleOrgIds allowlist are the app-layer backstop. A bug here can only
 * over-restrict (F1).
 *
 * `accessibleOrgIds: []` (a partner user granted no orgs) still emits
 * `org_id = ANY('{}')`, which matches nothing — an empty allowlist must never
 * read as "no filter".
 */
export async function loadSignals(q: {
  userId: string;
  partnerId: string;
  accessibleOrgIds: string[] | null;
  window?: { start: Date; end: Date };
  ids?: string[];
  includeDecided?: boolean;
}): Promise<LoadedSignal[]> {
  const conds = [
    sql`rs.user_id = ${q.userId}`,
    sql`rs.started_at IS NOT NULL AND rs.ended_at IS NOT NULL`,
    sql`rs.status IN ('disconnected','failed')`,
  ];
  if (q.window) conds.push(sql`rs.ended_at >= ${utcTs(q.window.start)} AND rs.ended_at < ${utcTs(q.window.end)}`);
  if (q.ids) conds.push(sql`rs.id = ANY(${uuidArray(q.ids)})`);
  if (q.accessibleOrgIds) conds.push(sql`rs.org_id = ANY(${uuidArray(q.accessibleOrgIds)})`);
  if (!q.includeDecided) {
    conds.push(sql`NOT EXISTS (SELECT 1 FROM time_suggestion_decisions x
      WHERE x.user_id = ${q.userId} AND x.signal_kind = 'remote_session' AND x.signal_id = rs.id)`);
  }

  const rows = (await db.execute(sql`
    SELECT rs.id, rs.type, rs.device_id,
           (rs.started_at AT TIME ZONE 'UTC') AS started_at,
           (rs.ended_at   AT TIME ZONE 'UTC') AS ended_at,
           rs.duration_seconds, rs.error_message,
           rs.org_id, o.name AS org_name, o.type AS org_type,
           d.hostname AS device_hostname,
           qs.attributed_org_id, ao.name AS attributed_org_name, qs.attribution_label
    FROM remote_sessions rs
    JOIN organizations o ON o.id = rs.org_id AND o.partner_id = ${q.partnerId}
    LEFT JOIN devices d ON d.id = rs.device_id
    LEFT JOIN LATERAL (
      SELECT ss.attributed_org_id, ss.attribution_label
      FROM support_sessions ss
      WHERE o.type = 'quick_support' AND ss.device_id = rs.device_id
      ORDER BY ss.created_at DESC LIMIT 1
    ) qs ON true
    LEFT JOIN organizations ao ON ao.id = qs.attributed_org_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY rs.started_at
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const base = {
      id: String(r.id),
      type: r.type as SignalRow['type'],
      deviceId: String(r.device_id),
      startedAt: new Date(r.started_at as string | Date),
      endedAt: new Date(r.ended_at as string | Date),
      durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      errorMessage: (r.error_message as string | null) ?? null,
    };
    return {
      ...base,
      precision: classifySignal(base).precision,
      orgId: String(r.org_id),
      orgName: String(r.org_name),
      orgType: String(r.org_type),
      deviceHostname: (r.device_hostname as string | null) ?? null,
      attributedOrgId: (r.attributed_org_id as string | null) ?? null,
      attributedOrgName: (r.attributed_org_name as string | null) ?? null,
      attributionLabel: (r.attribution_label as string | null) ?? null,
    };
  });
}

/**
 * F19 — everything this technician has ALREADY logged inside the day window.
 * One query per list call, not one per suggestion. Ranges are clipped to the
 * window in SQL so the TS side only unions and intersects.
 *
 * A running timer (`ended_at IS NULL`) counts as `[started_at, now)` clipped to
 * the window — not zero-length (which would re-suggest work in progress) and
 * not open-ended to end-of-day (which would hide everything after it). Runs in
 * the caller's DB context; the partner-axis time_entries policy plus the
 * explicit `user_id` predicate are the walls.
 */
export async function loadLoggedRanges(q: { userId: string; window: { start: Date; end: Date } }): Promise<LoggedRange[]> {
  const rows = (await db.execute(sql`
    WITH bounds AS (
      SELECT ${utcTs(q.window.start)} AS day_start,
             ${utcTs(q.window.end)}   AS day_end,
             (statement_timestamp() AT TIME ZONE 'UTC') AS now_utc
    )
    -- The AT TIME ZONE 'UTC' on the SELECT list is load-bearing, not decoration.
    -- GREATEST/LEAST over the timestamp columns yields a timestamp WITHOUT time
    -- zone, which postgres.js hands back as a bare 'YYYY-MM-DD HH:MM:SS' string;
    -- new Date(...) then reads it in the NODE PROCESS's local zone. On any API
    -- host not running UTC that shifts every already-logged range by the offset,
    -- the overlap test finds nothing, and F19 silently stops suppressing work the
    -- technician already logged — one tap from a duplicate billable row. Casting
    -- back to timestamptz here matches what loadSignals already does for
    -- rs.started_at/ended_at. Caught by timeSuggestionDecisionsRls.integration
    -- .test.ts running on an America/Denver host.
    SELECT (GREATEST(te.started_at, b.day_start) AT TIME ZONE 'UTC')               AS range_start,
           (LEAST(COALESCE(te.ended_at, b.now_utc), b.day_end) AT TIME ZONE 'UTC') AS range_end
    FROM time_entries te CROSS JOIN bounds b
    WHERE te.user_id = ${q.userId}
      AND te.started_at < b.day_end
      AND COALESCE(te.ended_at, b.now_utc) > b.day_start
  `)) as unknown as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({ startedAt: new Date(r.range_start as string | Date), endedAt: new Date(r.range_end as string | Date) }))
    .filter((r) => r.endedAt.getTime() > r.startedAt.getTime());
}

function resolveWindow(date: string, tz: string | undefined, partnerTz: string): { window: { start: Date; end: Date }; timezone: string } {
  const timezone = tz ?? partnerTz ?? 'UTC';
  if (!isValidIanaTimezone(timezone)) throw new TimeEntryServiceError(`Unknown timezone ${timezone}`, 400, 'INVALID_TZ');
  const window = dayWindowUtc(date, timezone);
  if (Number.isNaN(window.start.getTime()) || Number.isNaN(window.end.getTime())) {
    throw new TimeEntryServiceError('Invalid date', 400, 'INVALID_RANGE');
  }
  if (Date.now() - window.end.getTime() > MAX_LOOKBACK_DAYS * 24 * 60 * 60_000) {
    throw new TimeEntryServiceError(`date must be within the last ${MAX_LOOKBACK_DAYS} days`, 400, 'INVALID_RANGE');
  }
  return { window, timezone };
}

/** Groups (merge) + threshold filter shared by list and count so the two never disagree. */
function groupSignals(signals: LoadedSignal[], settings: SessionSuggestionSettings): LoadedSignal[][] {
  const kept = signals.filter((s) => {
    const { durationSeconds } = classifySignal(s);
    // Unreliable rows (durationSeconds null) are never hidden (F7).
    return durationSeconds == null || durationSeconds >= settings.minSessionSeconds;
  });
  return mergeSignals(kept, settings.mergeGapMinutes);
}

async function loadTicketCandidates(q: {
  partnerId: string; actorId: string; deviceIds: string[]; window: { start: Date; end: Date }; orgId?: string;
}): Promise<Array<TicketCandidateRow & { deviceId: string }>> {
  if (q.deviceIds.length === 0) return [];
  const lo = new Date(q.window.start.getTime() - TICKET_WINDOW_BEFORE_MS);
  const hi = new Date(q.window.end.getTime() + UNRELIABLE_AFTER_MS + TICKET_WINDOW_AFTER_MS);
  const orgCond = q.orgId ? sql`AND t.org_id = ${q.orgId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.org_id, t.device_id, t.assigned_to, t.closed_by,
           (t.closed_at AT TIME ZONE 'UTC') AS closed_at,
           (sc.created_at AT TIME ZONE 'UTC') AS actor_status_change_at, sc.new_value AS actor_status_change_to
    FROM tickets t
    LEFT JOIN LATERAL (
      SELECT c.created_at, c.new_value FROM ticket_comments c
      WHERE c.ticket_id = t.id AND c.user_id = ${q.actorId} AND c.comment_type = 'status_change'
        AND c.deleted_at IS NULL
        AND c.new_value IN ('resolved','closed')
        AND c.created_at >= ${utcTs(lo)} AND c.created_at < ${utcTs(hi)}
      ORDER BY c.created_at DESC LIMIT 1
    ) sc ON true
    WHERE t.partner_id = ${q.partnerId}
      AND t.deleted_at IS NULL
      AND t.device_id = ANY(${uuidArray(q.deviceIds)})
      ${orgCond}
      AND (t.assigned_to = ${q.actorId} OR t.closed_by = ${q.actorId} OR sc.created_at IS NOT NULL)
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    ticketNumber: String(r.ticket_number ?? ''),
    subject: String(r.subject ?? ''),
    status: String(r.status),
    orgId: String(r.org_id),
    deviceId: String(r.device_id),
    assignedTo: (r.assigned_to as string | null) ?? null,
    closedBy: (r.closed_by as string | null) ?? null,
    closedAt: r.closed_at ? new Date(r.closed_at as string | Date) : null,
    actorStatusChangeAt: r.actor_status_change_at ? new Date(r.actor_status_change_at as string | Date) : null,
    actorStatusChangeTo: (r.actor_status_change_to as string | null) ?? null,
  }));
}

function toSuggestion(
  group: LoadedSignal[],
  actorId: string,
  tickets: Array<TicketCandidateRow & { deviceId: string }>,
  loggedRanges: LoggedRange[],
): TimeSuggestion {
  const head = group[0]!;
  const isQuickSupport = head.orgType === 'quick_support';
  const env = envelopeOf(group);
  // QS sessions run under the hidden org, so a candidate ticket can only come
  // from the ATTRIBUTED org — and only when one is recorded (D4/F12).
  const mine = tickets.filter((t) =>
    t.deviceId === head.deviceId
    && (!isQuickSupport || (head.attributedOrgId != null && t.orgId === head.attributedOrgId)));
  const ranked = rankTicketCandidates(mine, actorId, env);
  return {
    key: suggestionKey(group.map((s) => s.id)),
    signals: group.map((s) => ({
      kind: 'remote_session' as const, id: s.id, type: s.type,
      startedAt: s.startedAt.toISOString(), endedAt: s.endedAt.toISOString(), precision: s.precision,
    })),
    startedAt: env.startedAt.toISOString(),
    endedAt: env.endedAt ? env.endedAt.toISOString() : null,
    durationMinutes: env.durationMinutes,
    device: head.deviceHostname ? { id: head.deviceId, hostname: head.deviceHostname } : null,
    // D6: the hidden quick_support org is never shown and never stamped.
    org: isQuickSupport ? null : { id: head.orgId, name: head.orgName },
    quickSupport: isQuickSupport ? { attributionLabel: head.attributionLabel, attributedOrgName: head.attributedOrgName } : null,
    candidateTicket: ranked.candidate
      ? {
        id: ranked.candidate.id, ticketNumber: ranked.candidate.ticketNumber,
        subject: ranked.candidate.subject, status: ranked.candidate.status, reason: ranked.candidate.reason,
      }
      : null,
    otherTickets: ranked.otherTickets.map((t) => ({ id: t.id, ticketNumber: t.ticketNumber, subject: t.subject })),
    suggestedSource: isQuickSupport ? 'support_session' : 'remote_session',
    // F19: residual overlap only — anything >= the drop ratio is filtered out
    // by the caller and never reaches the client.
    alreadyLoggedOverlapMinutes: alreadyLoggedVerdict(env, loggedRanges).overlapMinutes,
  };
}

/** F19 filter, shared by list and count so the two can never disagree. */
function dropAlreadyLogged(groups: LoadedSignal[][], loggedRanges: LoggedRange[]): LoadedSignal[][] {
  if (loggedRanges.length === 0) return groups;
  return groups.filter((g) => !alreadyLoggedVerdict(envelopeOf(g), loggedRanges).drop);
}

export async function listTimeSuggestions(
  actor: SuggestionActor,
  opts: { date: string; tz?: string; userId?: string },
): Promise<ListSuggestionsResult> {
  if (!actor.partnerId) throw new TimeEntryServiceError('Partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  const { settings, timezone: partnerTz } = await getSessionSuggestionSettings(actor.partnerId);
  if (!settings.enabled) {
    return { enabled: false, date: opts.date, timezone: opts.tz ?? partnerTz, suggestions: [], unloggedCount: 0 };
  }
  const { window, timezone } = resolveWindow(opts.date, opts.tz, partnerTz);
  const userId = opts.userId ?? actor.userId;

  const signals = await loadSignals({ userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds, window });
  // F19: fetch once, then drop windows the technician has already logged.
  const loggedRanges = await loadLoggedRanges({ userId, window });
  const groups = dropAlreadyLogged(groupSignals(signals, settings), loggedRanges);
  if (groups.length === 0) return { enabled: true, date: opts.date, timezone, suggestions: [], unloggedCount: 0 };

  const nonQs = groups.filter((g) => g[0]!.orgType !== 'quick_support');
  const qsWithOrg = groups.filter((g) => g[0]!.orgType === 'quick_support' && g[0]!.attributedOrgId);
  const tickets = [
    ...(await loadTicketCandidates({
      partnerId: actor.partnerId, actorId: userId,
      deviceIds: [...new Set(nonQs.map((g) => g[0]!.deviceId))], window,
    })),
    ...(await Promise.all(qsWithOrg.map((g) => loadTicketCandidates({
      partnerId: actor.partnerId!, actorId: userId, deviceIds: [g[0]!.deviceId], window, orgId: g[0]!.attributedOrgId!,
    })))).flat(),
  ];

  const suggestions = groups.map((g) => toSuggestion(g, userId, tickets, loggedRanges));
  return { enabled: true, date: opts.date, timezone, suggestions, unloggedCount: suggestions.length };
}

/**
 * W07 hook — same grouping as list, number only. Dispatch, quiet hours and
 * dedupe are W07.
 *
 * System context caveats for the W07 caller — read before wiring this up:
 * - `loadSignals` is safe here: `o.partner_id = :partner` and
 *   `rs.user_id = :user` are explicit predicates, not RLS side-effects.
 * - `loadLoggedRanges` is NOT partner-re-authorised — its only predicate is
 *   `te.user_id = :user`. With RLS bypassed it leans on `users` being
 *   single-partner, an invariant of another table. Keep it that way, or add an
 *   explicit partner predicate before this runs for a multi-partner user.
 * - Call this from a BACKGROUND path only. Per CLAUDE.md the wrap must be
 *   preceded by `runOutsideDbContext` when a request context may be open;
 *   inside a request `withSystemDbAccessContext` early-returns, so RLS stays
 *   ON while `accessibleOrgIds: null` below still assumes it is off.
 */
export async function countUnloggedSuggestions(args: { userId: string; partnerId: string; date: string; tz?: string }): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const { settings, timezone: partnerTz } = await getSessionSuggestionSettings(args.partnerId);
    if (!settings.enabled) return 0;
    const { window } = resolveWindow(args.date, args.tz, partnerTz);
    const signals = await loadSignals({ userId: args.userId, partnerId: args.partnerId, accessibleOrgIds: null, window });
    const loggedRanges = await loadLoggedRanges({ userId: args.userId, window });
    // Same F19 filter as list — a push that says "3 unlogged sessions" while
    // the screen shows 1 is worse than no push at all.
    return dropAlreadyLogged(groupSignals(signals, settings), loggedRanges).length;
  });
}

// ── decisions ────────────────────────────────────────────────────────────────

async function requireEnabled(actor: SuggestionActor): Promise<SessionSuggestionSettings> {
  if (!actor.partnerId) throw new TimeEntryServiceError('Partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  const { settings } = await getSessionSuggestionSettings(actor.partnerId);
  if (!settings.enabled) {
    throw new TimeEntryServiceError('Session suggestions are disabled for this partner', 403, 'SUGGESTIONS_DISABLED');
  }
  return settings;
}

/**
 * Re-reads the named signals under the caller's RLS + user/partner/org
 * predicates. Anything missing is 404 — a foreign or forged id is
 * indistinguishable from a purged one on purpose (F2).
 */
async function loadOwnedSignals(actor: SuggestionActor, signals: SuggestionSignalRef[]): Promise<LoadedSignal[]> {
  const ids = signals.map((s) => s.id);
  const rows = await loadSignals({
    userId: actor.userId, partnerId: actor.partnerId!, accessibleOrgIds: actor.accessibleOrgIds,
    ids, includeDecided: true,
  });
  if (rows.length !== ids.length) throw new TimeEntryServiceError('Session not found', 404, 'SIGNAL_NOT_FOUND');
  return rows;
}

/**
 * Serialises concurrent confirms of the same (user, signal) INSIDE the request
 * transaction. A raised 23505 would abort the whole request (#2189), so the
 * lock — not a unique-violation retry — is what makes a double tap yield one
 * entry; the ON CONFLICT DO NOTHING on the ledger insert is only a backstop.
 * Ids are locked in sorted order so two overlapping merged suggestions cannot
 * deadlock against each other.
 */
async function lockSignals(userId: string, ids: string[]): Promise<void> {
  for (const id of [...ids].sort()) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:remote_session:${id}`}))`);
  }
}

async function readDecisions(userId: string, ids: string[]): Promise<Array<{ signalId: string; decision: string; timeEntryId: string | null }>> {
  const rows = (await db.execute(sql`
    SELECT signal_id, decision, time_entry_id FROM time_suggestion_decisions
    WHERE user_id = ${userId} AND signal_kind = 'remote_session' AND signal_id = ANY(${uuidArray(ids)})
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    signalId: String(r.signal_id),
    decision: String(r.decision),
    timeEntryId: (r.time_entry_id as string | null) ?? null,
  }));
}

/**
 * F19 and confirm — deliberate non-check. Confirm does NOT re-run the
 * already-logged overlap test: the technician saw the residual
 * `alreadyLoggedOverlapMinutes` in the sheet and chose to log anyway, and a
 * server-side refusal would make a legitimate "I worked on two things in that
 * hour" impossible while adding no tenant-safety value. F19 is list-side only.
 */
export async function confirmTimeSuggestion(
  input: ConfirmSuggestionInput,
  actor: SuggestionActor,
): Promise<{ entry: TimeEntryRow; replay: boolean }> {
  await requireEnabled(actor);
  const ids = input.signals.map((s) => s.id);
  await lockSignals(actor.userId, ids);

  const signals = await loadOwnedSignals(actor, input.signals);
  if (signals.some((s) => Number.isNaN(s.endedAt.getTime()))) {
    throw new TimeEntryServiceError('Session has not ended', 409, 'SIGNAL_NOT_ENDED');
  }

  // Existing decisions: full replay -> 200; tombstone -> 410; dismissed -> 409.
  const decisions = await readDecisions(actor.userId, ids);
  if (decisions.some((d) => d.decision === 'dismissed')) {
    throw new TimeEntryServiceError('Suggestion was dismissed — restore it first', 409, 'SUGGESTION_DISMISSED');
  }
  if (decisions.some((d) => d.decision === 'confirmed' && d.timeEntryId == null)) {
    throw new TimeEntryServiceError('The time entry created from this session was deleted', 410, 'SUGGESTION_ENTRY_DELETED');
  }
  const entryIds = new Set(decisions.map((d) => d.timeEntryId));
  if (decisions.length === ids.length && entryIds.size === 1) {
    // Re-read with the SAME selection createTimeEntry returns, so the replay
    // body is shape-identical to the 201 body. A raw `SELECT *` here would hand
    // the client snake_case columns and break `entry.durationMinutes`.
    const entry = await readTimeEntryById([...entryIds][0]!);
    if (entry) return { entry, replay: true };
    throw new TimeEntryServiceError('The time entry created from this session was deleted', 410, 'SUGGESTION_ENTRY_DELETED');
  }
  if (decisions.length > 0) {
    // A partial ledger: some members already belong to another entry. Logging
    // the rest would double-bill the overlap, so refuse and let the client
    // refetch.
    throw new TimeEntryServiceError('Some sessions are already logged to a different entry', 409, 'SUGGESTION_PARTIALLY_LOGGED');
  }

  const orgIds = new Set(signals.map((s) => s.orgId));
  if (orgIds.size !== 1) throw new TimeEntryServiceError('Sessions span more than one organization', 422, 'ORG_MISMATCH');
  const head = signals[0]!;
  const isQuickSupport = head.orgType === 'quick_support';

  const env = envelopeOf(signals);
  const rangeError = validateConfirmRange(env, { startedAt: input.startedAt, endedAt: input.endedAt });
  if (rangeError === 'ENDED_AT_REQUIRED') {
    throw new TimeEntryServiceError('endedAt is required for a session with an unreliable end', 400, 'ENDED_AT_REQUIRED');
  }
  if (rangeError === 'RANGE_OUTSIDE_SIGNAL') {
    throw new TimeEntryServiceError('Start/end must stay within 15 minutes of the recorded session', 400, 'RANGE_OUTSIDE_SIGNAL');
  }
  const endedAt = input.endedAt ?? env.endedAt!;

  // Org / currency resolution (spec confirm step 4).
  let provenance: { source: 'remote_session' | 'support_session'; orgLink: { orgId: string; currencyCode: string } | null };
  let description = input.description;
  if (input.ticketId) {
    // The ticket path inside createTimeEntry stamps org + currency under its own
    // locks; here we only assert the ticket belongs to the session's org for
    // non-QS sessions (F3) so a mis-picked ticket cannot silently move the money
    // to another customer.
    const [ticket] = (await db.execute(sql`
      SELECT org_id FROM tickets WHERE id = ${input.ticketId} AND deleted_at IS NULL
    `)) as unknown as Array<{ org_id: string }>;
    if (!ticket) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    if (!isQuickSupport && ticket.org_id !== head.orgId) {
      throw new TimeEntryServiceError('Ticket belongs to a different organization than the session', 422, 'ORG_MISMATCH');
    }
    provenance = { source: isQuickSupport ? 'support_session' : 'remote_session', orgLink: null };
  } else if (isQuickSupport) {
    // D6: never the hidden quick_support org, never attributed_org_id — the
    // attribution is a reporting hint, and stamping it would turn a hint into a
    // billing fact.
    provenance = { source: 'support_session', orgLink: null };
    if (head.attributionLabel) {
      description = description ? `${head.attributionLabel} — ${description}` : head.attributionLabel;
    }
  } else {
    provenance = { source: 'remote_session', orgLink: await resolveAndLockOrgLink(head.orgId, actor) };
  }

  const entry = await createTimeEntry(
    {
      ticketId: input.ticketId ?? undefined,
      startedAt: input.startedAt,
      endedAt,
      description,
      isBillable: input.isBillable,
      hourlyRate: input.hourlyRate,
    } as Parameters<typeof createTimeEntry>[0],
    actor,
    provenance,
  );

  await db
    .insert(timeSuggestionDecisions)
    .values(ids.map((signalId) => ({
      partnerId: actor.partnerId!, userId: actor.userId,
      signalKind: 'remote_session', signalId, decision: 'confirmed', timeEntryId: entry.id,
    })))
    .onConflictDoNothing()
    .returning();

  return { entry, replay: false };
}

export async function dismissTimeSuggestions(signals: SuggestionSignalRef[], actor: SuggestionActor): Promise<void> {
  await requireEnabled(actor);
  await loadOwnedSignals(actor, signals);
  await db
    .insert(timeSuggestionDecisions)
    .values(signals.map((s) => ({
      partnerId: actor.partnerId!, userId: actor.userId,
      signalKind: s.kind, signalId: s.id, decision: 'dismissed', timeEntryId: null,
    })))
    .onConflictDoNothing()
    .returning();
  // One mutation PER signal, never a joined id string: `writeAuditEventAsync`
  // only stores `resource_id` when the value parses as a uuid, so a merged
  // suggestion's "<uuidA>+<uuidB>" would land resource_id NULL and a
  // details.entryIds array whose single element is not an id (review W06A).
  for (const s of signals) {
    actor.recordAuditMutation?.({ action: 'time_suggestion.dismissed', entryId: s.id, orgId: null });
  }
}

/**
 * "Re-suggest": removes the actor's dismissed rows AND confirmed tombstones
 * (the entry was deleted). Idempotent. Scoped to `user_id = actor` so it can
 * only ever remove the caller's own decisions.
 */
export async function undismissTimeSuggestions(signals: SuggestionSignalRef[], actor: SuggestionActor): Promise<void> {
  await requireEnabled(actor);
  await db.delete(timeSuggestionDecisions).where(and(
    eq(timeSuggestionDecisions.userId, actor.userId),
    eq(timeSuggestionDecisions.signalKind, 'remote_session'),
    inArray(timeSuggestionDecisions.signalId, signals.map((s) => s.id)),
    or(
      eq(timeSuggestionDecisions.decision, 'dismissed'),
      and(eq(timeSuggestionDecisions.decision, 'confirmed'), isNull(timeSuggestionDecisions.timeEntryId)),
    ),
  ));
  for (const s of signals) {
    actor.recordAuditMutation?.({ action: 'time_suggestion.undismissed', entryId: s.id, orgId: null });
  }
}
