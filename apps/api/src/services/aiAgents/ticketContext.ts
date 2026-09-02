/**
 * Bounded hostile-context assembler for a ticket-triggered agent run (wave 6
 * PR 3, #3828 — Task 4; extended by Phase 2 wave P2-4 (#4191) Task 7 with the
 * linked-device signal and similar-resolved-tickets sections below).
 *
 * ## Threat model
 *
 * Ticket content is attacker-controlled: `subject`/`description` arrive
 * unauthenticated from the portal or inbound email, and comments can be
 * posted by any authenticated portal user. This module is the trust boundary
 * between that content and the model's context window — every property below
 * is enforced HERE, not left to the caller:
 *
 *  - **HTML-stripped.** `sanitize-html` with `allowedTags: []` — the model
 *    never sees a raw tag, so it can never be tricked by a
 *    `<system>`/`<operator-guidance>`-shaped fragment smuggled in as ticket
 *    content (see runnerPrompt.ts's header for why that fence matters).
 *  - **PII-excluded.** `submitterEmail`/`submitterName`/`submittedBy`,
 *    `customFields`, `attachments`, and `externalTicketUrl` are never
 *    selected off the `tickets` row at all — there is no field to
 *    accidentally forward. The same applies to comments: `authorName` (for a
 *    portal/email comment, the REQUESTER's own display name) is never
 *    selected either — only `authorType`, a non-identifying role label, is.
 *  - **Agent-note-excluded.** Only comments with `originPrincipalKind =
 *    'user'` AND `agentRunId IS NULL` are read (see
 *    `ticketHelpdeskSubscriber.ts`'s `HUMAN_ORIGIN_KIND` and its loop guard,
 *    which treats a comment as agent-originated on EITHER signal) — an
 *    agent's own prior proposal (were one ever written back, which this PR
 *    does not do) must never feed the next run's context, which would be a
 *    prompt-injection self-loop. Filtering on `originPrincipalKind` alone
 *    would miss a comment that has `agentRunId` set but whose kind was left
 *    at its 'user' default.
 *  - **Size-bounded.** 8KiB soft target / 12KiB hard ceiling — see
 *    `TICKET_CONTEXT_SOFT_LIMIT_BYTES`/`TICKET_CONTEXT_HARD_LIMIT_BYTES`. The
 *    ceiling is enforced over the WHOLE serialized context (including the two
 *    P2-4 sections below), byte-based, the same measurement idiom
 *    `anomalyContext.ts`'s sibling trim uses (`Buffer.byteLength(JSON.
 *    stringify(...), 'utf8')`) but scoped to the WHOLE object, matching
 *    `narrativeContext.ts`'s whole-context ceiling.
 *
 * ## The two P2-4 sections (Task 7)
 *
 *  - **`linkedDevice`** — set only when `tickets.device_id` is populated and
 *    the device still resolves inside `orgId`. Carries the device's identity
 *    plus three signals a triage run benefits from: last-24h alerts on that
 *    device (rule name + severity + count — the model gets the SHAPE of
 *    recent alert activity, never the alert message text, which is
 *    customer/attacker-reachable through `context`/`message` and out of
 *    scope for this bounded module), the LIVE (non-superseded) verdict
 *    classification histogram for those same alerts, and the device's
 *    findings from the most recently COMPLETED `sweep`-profile run for this
 *    org (this module's definition of "open": a sweep re-evaluates the whole
 *    fleet every occurrence, so the latest completed run's findings for this
 *    device are the current standing picture — an OLDER run's findings for
 *    the same device are superseded by definition and never read). Rule
 *    names, the device's hostname/displayName, and sweep-finding titles are
 *    all operator/self-reported free text — same class of hostile single-line
 *    string `runnerPrompt.ts`'s `sanitizeSweepText` was written to defend
 *    against (a hostname or rule name containing `\n` could otherwise forge
 *    an extra line/row once rendered) — so every one of them is run through
 *    `sanitizeSweepText` HERE, at assembly, matching this module's existing
 *    "enforce at assembly, not at render" posture. `kind`/`severity` on a
 *    sweep finding are validated against the closed `AI_SWEEP_KINDS`/
 *    `AI_SWEEP_SEVERITIES` whitelists (defense in depth: the outcome tool
 *    already constrains them at write time via `sweepFindingsOutcomeSchema`,
 *    but this module never trusts an upstream validator it doesn't own —
 *    same posture as `narrativeContext.ts`'s `histogram()`); a finding whose
 *    `kind`/`severity` falls outside the whitelist is dropped, not forwarded
 *    under an unvetted label.
 *  - **`similarResolvedTickets`** — up to `MAX_SIMILAR_RESOLVED_TICKETS`
 *    (most-recently-resolved first) other RESOLVED tickets in this org
 *    sharing the current ticket's `category_id`, joined through
 *    `ticket_categories` on `(category_id, partner_id)` — the same
 *    same-partner-category idiom `ticketService.ts`'s
 *    `assertCategoryInPartner` and `narrativeContext.ts`'s `loadTickets`
 *    both use. Each entry is `{ title, resolutionNote }`: `title` is the
 *    resolved ticket's subject (HTML-stripped, then `sanitizeSweepText`-
 *    clamped to 256 chars — a title is a single-line field), `resolutionNote`
 *    is HTML-stripped and clamped to 500 chars WITHOUT `sanitizeSweepText`'s
 *    whitespace-collapsing (a resolution write-up is legitimately
 *    multi-line prose, unlike a title/hostname/rule-name).
 *
 * Both sections fail CLOSED on the VALUE: a loader failure (network blip, a
 * malformed jsonb row, etc.) surfaces as `linkedDevice: null` /
 * `similarResolvedTickets: []` via `Promise.allSettled` isolation in
 * `loadTicketContext` (a rejected loader is logged and reported to Sentry,
 * never thrown). That value alone would conflate "the ticket genuinely has
 * no linked device/category" with "the signal could not be loaded" —
 * exactly the "unavailable ≠ zero" trap this repo's context assemblers
 * (`narrativeContext.ts`, `anomalyContext.ts`) all guard against. So each
 * section carries a companion `linkedDeviceUnavailable`/
 * `similarResolvedTicketsUnavailable` flag, present (`true`) ONLY when the
 * ticket actually HAD a `deviceId`/`categoryId` but that section's loader
 * rejected — a ticket with no device/category at all gets the plain
 * `null`/`[]` with no flag, since there was never anything to fail to load.
 * `ticketPromptLines` (runnerPrompt.ts) renders a one-line hedge when a flag
 * is set, telling the model not to infer a negative from the absence. The
 * flag is never touched by the byte-budget trim below — it costs a handful
 * of fixed bytes and dropping it would silently reintroduce the exact
 * conflation it exists to prevent.
 *
 * `assembleTicketContext` is the pure core (fixture-testable, no DB) that
 * `loadTicketContext` wraps with the actual reads.
 */
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import {
  AI_ALERT_VERDICT_CLASSIFICATIONS,
  AI_SWEEP_KINDS,
  AI_SWEEP_SEVERITIES,
  type AiAlertVerdictClassification,
  type AiSweepKind,
  type AiSweepSeverity,
} from '@breeze/shared';
import { db } from '../../db';
import { tickets, ticketComments } from '../../db/schema/portal';
import { captureException } from '../sentry';
// Value import (not a type-only one), mirroring `narrativeContext.ts`'s
// identical borrow of the same function: `runnerPrompt.ts` has NO runtime
// imports of its own (both of its imports of this module's siblings are
// `import type`), so this edge introduces no cycle in either direction.
import { sanitizeSweepText } from './runnerPrompt';

/** Aim: a typical ticket's context should fit comfortably under this. Not
 *  independently enforced — the hard ceiling below is the real invariant —
 *  but comments/description are trimmed toward it first when both apply. */
export const TICKET_CONTEXT_SOFT_LIMIT_BYTES = 8 * 1024;

/** Never exceeded: `assembleTicketContext` always returns a context whose
 *  WHOLE serialized JSON representation fits under this many UTF-8 bytes. */
export const TICKET_CONTEXT_HARD_LIMIT_BYTES = 12 * 1024;

/** `ticketHelpdeskSubscriber.ts`'s HUMAN_ORIGIN_KIND — duplicated as a literal
 *  rather than imported to avoid coupling this read-only module to the
 *  subscriber's module graph; both are asserted against the same migration
 *  comment / design authority. */
const HUMAN_ORIGIN_KIND = 'user';

/** Oldest-first — a comment is dropped a full CHARS_PER_TRUNCATE_STEP at a
 *  time off the description tail once every comment has already been cut. */
const DESCRIPTION_TRUNCATE_STEP_CHARS = 256;

const TRUNCATION_SUFFIX = '… [truncated]';

/** ≤10 per the plan's design authority — plenty for a helpdesk agent's
 *  read-only context, and small enough that the byte ceiling above is the
 *  binding constraint only for unusually long individual comments. */
export const TICKET_CONTEXT_MAX_COMMENTS = 10;

/** How many of the device's last-24h alert (rule, severity) groups the
 *  loader admits — see `loadLinkedDeviceContext`'s alerts statement. */
export const MAX_LINKED_DEVICE_ALERTS = 5;

/** "Last 24h" for the linked device's alert signal. */
const LINKED_DEVICE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Up to this many other resolved tickets in the same category — see this
 *  module's header. */
export const MAX_SIMILAR_RESOLVED_TICKETS = 3;

/** Clamp for an operator/self-reported single-line name: device hostname,
 *  device display name, alert rule name. `devices.hostname`/`display_name`
 *  are varchar(255); `alert_rules.name` is varchar(200) — this is headroom,
 *  not a live truncation, matching `narrativeContext.ts`'s `MAX_NAME_CHARS`. */
const NAME_MAX_CHARS = 255;

/** Clamp for a sweep-finding title and a similar-resolved-ticket title — both
 *  single-line fields rendered as one row/line, per this module's header. */
const TITLE_MAX_CHARS = 256;

/** Clamp for a similar-resolved-ticket's resolution note. Deliberately NOT
 *  run through `sanitizeSweepText` (which collapses whitespace for a
 *  single-line render) — a resolution write-up is legitimately multi-line
 *  prose, so this is a plain length clamp. */
const RESOLUTION_NOTE_MAX_CHARS = 500;

export interface TicketContextComment {
  /** `ticket_comments.author_type` ('portal' | 'email' | 'internal' | ...) —
   *  NEVER `authorName`: that column holds the actor's own display name
   *  (for a portal/email comment, the REQUESTER's name), which is exactly
   *  the `submitterName` PII the design authority excludes from context. */
  authorType: string | null;
  content: string;
  createdAt: string;
}

export interface TicketContextLinkedDeviceAlert {
  ruleName: string;
  severity: string;
  count: number;
}

export interface TicketContextLinkedDeviceSweepFinding {
  kind: AiSweepKind;
  severity: AiSweepSeverity;
  title: string;
}

export interface TicketContextLinkedDevice {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  /** Busiest (rule, severity) pair first, last 24h — capped to
   *  `MAX_LINKED_DEVICE_ALERTS`. */
  alerts: TicketContextLinkedDeviceAlert[];
  /** Live (non-superseded) verdict classification histogram for this
   *  device's alerts in the same 24h window — a zeroed set over every
   *  `AiAlertVerdictClassification`, not just the ones observed. */
  verdicts: Record<AiAlertVerdictClassification, number>;
  /** This device's findings from the most recently COMPLETED `sweep`-profile
   *  run for the org — see this module's header on why "latest run" is this
   *  module's definition of "open". */
  sweepFindings: TicketContextLinkedDeviceSweepFinding[];
}

export interface TicketContextSimilarResolvedTicket {
  title: string;
  resolutionNote: string | null;
}

export interface TicketRunContext {
  id: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  tags: string[];
  dueDate: string | null;
  /** Oldest first — chronological reading order for the model. */
  comments: TicketContextComment[];
  /** `null` when the ticket has no linked device, the device could not be
   *  resolved, or the signal could not be loaded — see `linkedDeviceUnavailable`
   *  below to tell the failure case apart from genuine absence. */
  linkedDevice: TicketContextLinkedDevice | null;
  /** Present (always `true`) ONLY when the ticket has a `deviceId` but the
   *  `linkedDevice` signal could not be loaded — see this module's header. */
  linkedDeviceUnavailable?: true;
  /** Empty when the ticket has no category, none were found, or the signal
   *  could not be loaded — see `similarResolvedTicketsUnavailable` below to
   *  tell the failure case apart from genuine absence. */
  similarResolvedTickets: TicketContextSimilarResolvedTicket[];
  /** Present (always `true`) ONLY when the ticket has a `categoryId` but the
   *  `similarResolvedTickets` signal could not be loaded — see this module's
   *  header. */
  similarResolvedTicketsUnavailable?: true;
  /** True when ANY section was cut to fit the hard ceiling — surfaced in the
   *  prompt so the model knows the context is partial rather than silently
   *  missing history. */
  truncated: boolean;
}

function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

interface RawTicketRow {
  id: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  tags: string[] | null;
  dueDate: Date | string | null;
  deviceId: string | null;
  categoryId: string | null;
}

interface RawCommentRow {
  authorType: string | null;
  content: string;
  createdAt: Date | string;
}

export interface RawLinkedDeviceAlertRow {
  ruleName: string | null;
  severity: string;
  count: number;
}

export interface RawLinkedDeviceVerdictRow {
  classification: string | null;
  count: number;
}

export interface RawLinkedDeviceSweepFindingRow {
  kind: string | null;
  severity: string | null;
  title: string | null;
}

export interface RawLinkedDevice {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  alerts: RawLinkedDeviceAlertRow[];
  verdicts: RawLinkedDeviceVerdictRow[];
  sweepFindings: RawLinkedDeviceSweepFindingRow[];
}

export interface RawSimilarResolvedTicket {
  title: string;
  resolutionNote: string | null;
}

function zeroedVerdictCounts(): Record<AiAlertVerdictClassification, number> {
  const out = {} as Record<AiAlertVerdictClassification, number>;
  for (const key of AI_ALERT_VERDICT_CLASSIFICATIONS) out[key] = 0;
  return out;
}

const KNOWN_SWEEP_KINDS = new Set<string>(AI_SWEEP_KINDS);
const KNOWN_SWEEP_SEVERITIES = new Set<string>(AI_SWEEP_SEVERITIES);
const KNOWN_VERDICT_CLASSIFICATIONS = new Set<string>(AI_ALERT_VERDICT_CLASSIFICATIONS);

/** Pure assembly of the `linkedDevice` section — sanitizes every operator/
 *  self-reported string field and drops any sweep finding whose `kind`/
 *  `severity` falls outside the closed whitelists. See this module's header. */
function assembleLinkedDevice(raw: RawLinkedDevice): TicketContextLinkedDevice {
  const verdicts = zeroedVerdictCounts();
  for (const row of raw.verdicts) {
    if (row.classification && KNOWN_VERDICT_CLASSIFICATIONS.has(row.classification)) {
      verdicts[row.classification as AiAlertVerdictClassification] += row.count;
    }
  }

  return {
    id: raw.id,
    hostname: sanitizeSweepText(raw.hostname, NAME_MAX_CHARS),
    displayName: raw.displayName ? sanitizeSweepText(raw.displayName, NAME_MAX_CHARS) : null,
    osType: raw.osType,
    alerts: raw.alerts
      .filter((row): row is RawLinkedDeviceAlertRow & { ruleName: string } => Boolean(row.ruleName))
      .map((row) => ({
        ruleName: sanitizeSweepText(row.ruleName, NAME_MAX_CHARS),
        severity: row.severity,
        count: row.count,
      })),
    verdicts,
    sweepFindings: raw.sweepFindings
      .filter((row): row is { kind: string; severity: string; title: string } =>
        Boolean(row.kind) && KNOWN_SWEEP_KINDS.has(row.kind!)
        && Boolean(row.severity) && KNOWN_SWEEP_SEVERITIES.has(row.severity!)
        && Boolean(row.title))
      .map((row) => ({
        kind: row.kind as AiSweepKind,
        severity: row.severity as AiSweepSeverity,
        title: sanitizeSweepText(row.title, TITLE_MAX_CHARS),
      })),
  };
}

/** Pure assembly of one `similarResolvedTickets` entry — see this module's
 *  header on why `title` and `resolutionNote` are clamped differently. */
function assembleSimilarResolvedTicket(raw: RawSimilarResolvedTicket): TicketContextSimilarResolvedTicket {
  const strippedTitle = stripHtml(raw.title);
  const strippedNote = stripHtml(raw.resolutionNote);
  return {
    title: sanitizeSweepText(strippedTitle, TITLE_MAX_CHARS),
    resolutionNote: strippedNote ? strippedNote.slice(0, RESOLUTION_NOTE_MAX_CHARS) : null,
  };
}

/**
 * Pure assembly from already-fetched rows. Exported so unit tests can drive
 * every truncation branch deterministically without a DB.
 *
 * `comments` is expected NEWEST-FIRST (what an `ORDER BY created_at DESC
 * LIMIT N` query returns) — this function reverses it to oldest-first before
 * truncating (dropping the OLDEST comment first preserves the most recent,
 * most relevant history) and before returning (chronological order reads
 * naturally in the prompt).
 *
 * The hard byte ceiling is enforced over the WHOLE serialized context
 * (`JSON.stringify` of the return shape), never per-field — see this
 * module's header. The trim order, checked every iteration and applied ONE
 * unit at a time so the drop order is provably deterministic:
 *
 *  1. `similarResolvedTickets` (drop the least-recently-resolved, i.e. the
 *     tail of the already most-recent-first list)
 *  2. `linkedDevice.sweepFindings` (drop the tail)
 *  3. `linkedDevice.alerts` (drop the tail — least busy (rule, severity) pair)
 *  4. the OLDEST comment (existing rule)
 *  5. the description tail, `DESCRIPTION_TRUNCATE_STEP_CHARS` at a time
 *     (existing rule)
 */
export function assembleTicketContext(args: {
  ticket: RawTicketRow;
  comments: RawCommentRow[];
  linkedDevice?: RawLinkedDevice | null;
  /** True ONLY when the ticket has a `deviceId` but that signal's loader
   *  rejected — see this module's header. Never set when the ticket simply
   *  has no linked device. */
  linkedDeviceUnavailable?: boolean;
  similarResolvedTickets?: RawSimilarResolvedTicket[];
  /** Same contract as `linkedDeviceUnavailable`, for the `categoryId` axis. */
  similarResolvedTicketsUnavailable?: boolean;
}): TicketRunContext {
  const subject = stripHtml(args.ticket.subject);
  let description = stripHtml(args.ticket.description);
  const comments: TicketContextComment[] = args.comments
    .slice()
    .reverse()
    .map((c) => ({
      authorType: c.authorType,
      content: stripHtml(c.content),
      createdAt: isoString(c.createdAt) as string,
    }));

  let linkedDevice: TicketContextLinkedDevice | null = args.linkedDevice
    ? assembleLinkedDevice(args.linkedDevice)
    : null;
  let similarResolvedTickets: TicketContextSimilarResolvedTicket[] =
    (args.similarResolvedTickets ?? []).map(assembleSimilarResolvedTicket);

  // Constant for the life of this call — never touched by the trim loop
  // below (see this module's header on why the flag itself is never
  // dropped).
  const linkedDeviceUnavailable = args.linkedDeviceUnavailable === true;
  const similarResolvedTicketsUnavailable = args.similarResolvedTicketsUnavailable === true;

  let truncated = false;

  // The single source of truth for both the byte measurement below AND the
  // final return value — the two representations can never drift apart
  // because they're the same call.
  function snapshot(): TicketRunContext {
    return {
      id: args.ticket.id,
      subject,
      description: description || null,
      status: args.ticket.status,
      priority: args.ticket.priority,
      category: args.ticket.category,
      tags: args.ticket.tags ?? [],
      dueDate: isoString(args.ticket.dueDate),
      comments,
      linkedDevice,
      ...(linkedDeviceUnavailable ? { linkedDeviceUnavailable: true as const } : {}),
      similarResolvedTickets,
      ...(similarResolvedTicketsUnavailable ? { similarResolvedTicketsUnavailable: true as const } : {}),
      truncated,
    };
  }

  while (Buffer.byteLength(JSON.stringify(snapshot()), 'utf8') > TICKET_CONTEXT_HARD_LIMIT_BYTES) {
    if (similarResolvedTickets.length > 0) {
      similarResolvedTickets = similarResolvedTickets.slice(0, -1);
      truncated = true;
    } else if (linkedDevice && linkedDevice.sweepFindings.length > 0) {
      linkedDevice = { ...linkedDevice, sweepFindings: linkedDevice.sweepFindings.slice(0, -1) };
      truncated = true;
    } else if (linkedDevice && linkedDevice.alerts.length > 0) {
      linkedDevice = { ...linkedDevice, alerts: linkedDevice.alerts.slice(0, -1) };
      truncated = true;
    } else if (comments.length > 0) {
      comments.shift();
      truncated = true;
    } else if (description.length > 0) {
      description = description.slice(0, Math.max(0, description.length - DESCRIPTION_TRUNCATE_STEP_CHARS));
      truncated = true;
    } else {
      // Nothing left to drop: the residual bytes are the envelope itself
      // (fixed-shape fields, plus either unavailable flag when set). Bail
      // rather than spin.
      truncated = true;
      break;
    }
  }
  if (truncated && description) description = `${description}${TRUNCATION_SUFFIX}`;

  return snapshot();
}

/**
 * One place every P2-4 loader failure is reported from. `console.warn` (not
 * `error`) because the run itself is still healthy — the base ticket context
 * (subject/description/comments) loads independently and the two P2-4
 * sections simply degrade to absent, matching `narrativeContext.ts`'s
 * `reportLoaderFailure` posture.
 */
function reportLoaderFailure(orgId: string, loader: string, error: unknown): void {
  console.warn('[aiAgentTicketContext] context loader failed; section reported as absent', {
    orgId, loader, error,
  });
  captureException(error, undefined, {
    service: 'aiAgents',
    operation: 'loadTicketContext',
    loader,
    orgId,
  });
}

/** Raw-SQL helper — same idiom as `narrativeContext.ts`'s `query()`: the
 *  compiled statement (not an opaque builder chain) is what a unit test can
 *  actually assert an org pin on. */
async function query<T extends Record<string, unknown>>(statement: SQL): Promise<T[]> {
  const rows = await db.execute<T>(statement);
  return [...rows] as T[];
}

/** This org's `partner_id`, resolved from `organizations` — NEVER from a
 *  caller-supplied value. Every partner-axis clause below (the alert-rule
 *  owner admission, the `ticket_categories` join) is fail-closed on `null`:
 *  `partner_id = NULL` matches nothing in SQL, so a failed/missing header
 *  read admits no partner-wide rows rather than accidentally admitting every
 *  partner-wide row (matching `narrativeContext.ts`'s `loadHeader`). */
async function resolveOrgPartnerId(orgId: string): Promise<string | null> {
  const rows = await query<{ partner_id: string | null }>(sql`
    SELECT partner_id FROM organizations WHERE id = ${orgId}
  `);
  return rows[0]?.partner_id ?? null;
}

/**
 * The `linkedDevice` loader — one failure-isolation unit (see this module's
 * header). Returns `null` when the device does not resolve inside `orgId`
 * (moved/deleted reads as absent, same posture as the rest of this module);
 * throws (caught by the caller's `Promise.allSettled`) on any query error,
 * which is reported as ABSENT rather than as a false zero.
 */
export async function loadLinkedDeviceContext(deviceId: string, orgId: string): Promise<RawLinkedDevice | null> {
  const deviceRows = await query<{ id: string; hostname: string; display_name: string | null; os_type: string }>(sql`
    SELECT d.id AS id, d.hostname AS hostname, d.display_name AS display_name, d.os_type AS os_type
    FROM devices d
    WHERE d.id = ${deviceId} AND d.org_id = ${orgId}
    LIMIT 1
  `);
  const device = deviceRows[0];
  if (!device) return null;

  const partnerId = await resolveOrgPartnerId(orgId);
  const windowStart = new Date(Date.now() - LINKED_DEVICE_ALERT_WINDOW_MS).toISOString();

  // LEFT JOIN, with the owner admission INSIDE the ON clause — a partner-wide
  // rule (`org_id IS NULL`) legitimately owns this org's alerts (epic #2135);
  // an alert whose rule belongs to neither this org nor this org's partner
  // degrades to "no rule" and is dropped by the HAVING, same idiom as
  // `narrativeContext.ts`'s `loadAlerts`.
  const alertRows = await query<{ rule_name: string | null; severity: string; count: number }>(sql`
    SELECT r.name AS rule_name, a.severity AS severity, COUNT(*)::int AS count
    FROM alerts a
    LEFT JOIN alert_rules r ON r.id = a.rule_id
      AND (r.org_id = ${orgId} OR (r.org_id IS NULL AND r.partner_id = ${partnerId}))
    WHERE a.org_id = ${orgId}
      AND a.device_id = ${deviceId}
      AND a.created_at >= ${windowStart}
    GROUP BY r.name, a.severity
    HAVING r.name IS NOT NULL
    ORDER BY COUNT(*) DESC, r.name ASC
    LIMIT ${MAX_LINKED_DEVICE_ALERTS}
  `);

  // `ai_alert_verdicts` carries its own `org_id` (shape 1) — pinned on both
  // the verdict row and the joined alert, defense in depth matching
  // `narrativeContext.ts`. `superseded_by IS NULL` keeps one alert from being
  // counted once per re-verdict.
  const verdictRows = await query<{ classification: string | null; count: number }>(sql`
    SELECT v.classification AS classification, COUNT(*)::int AS count
    FROM ai_alert_verdicts v
    JOIN alerts a ON a.id = v.alert_id AND a.org_id = ${orgId}
    WHERE v.org_id = ${orgId}
      AND a.device_id = ${deviceId}
      AND a.created_at >= ${windowStart}
      AND v.superseded_by IS NULL
    GROUP BY v.classification
  `);

  // "Open" = this device's findings from the single most recently COMPLETED
  // sweep run for the org — see this module's header. `jsonb_typeof` guards
  // the array expansion the same way `narrativeContext.ts`'s `loadSweeps`
  // does: `jsonb_array_elements` is a set-returning function in the FROM
  // list, not guaranteed to run after a WHERE filter, so a malformed
  // `outcome` must never be able to raise and take the whole loader down.
  const sweepFindingRows = await query<{ kind: string | null; severity: string | null; title: string | null }>(sql`
    SELECT f.value->>'kind' AS kind, f.value->>'severity' AS severity, f.value->>'title' AS title
    FROM ai_agent_runs r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.outcome->'sweepFindings'->'findings') = 'array'
           THEN r.outcome->'sweepFindings'->'findings'
           ELSE '[]'::jsonb END
    ) AS f(value)
    WHERE r.org_id = ${orgId}
      AND r.profile = 'sweep'
      AND r.status = 'completed'
      AND r.id = (
        SELECT r2.id FROM ai_agent_runs r2
        WHERE r2.org_id = ${orgId} AND r2.profile = 'sweep' AND r2.status = 'completed'
        ORDER BY r2.queued_at DESC
        LIMIT 1
      )
      AND f.value->>'deviceId' = ${deviceId}
  `);

  return {
    id: device.id,
    hostname: device.hostname,
    displayName: device.display_name,
    osType: device.os_type,
    alerts: alertRows.map((row) => ({ ruleName: row.rule_name, severity: row.severity, count: row.count })),
    verdicts: verdictRows.map((row) => ({ classification: row.classification, count: row.count })),
    sweepFindings: sweepFindingRows.map((row) => ({ kind: row.kind, severity: row.severity, title: row.title })),
  };
}

/**
 * The `similarResolvedTickets` loader — one failure-isolation unit. Empty
 * when the ticket has no category (nothing to match on — not an error) or
 * when the query throws (caught by the caller's `Promise.allSettled`).
 */
export async function loadSimilarResolvedTickets(
  ticketId: string,
  categoryId: string,
  orgId: string,
): Promise<RawSimilarResolvedTicket[]> {
  const partnerId = await resolveOrgPartnerId(orgId);

  // `ticket_categories` is partner-owned (no `org_id` at all) — the join
  // carries `c.partner_id = $partner`, resolved from THIS org's own row,
  // same idiom as `ticketService.ts`'s `assertCategoryInPartner` and
  // `narrativeContext.ts`'s `loadTickets`.
  const rows = await query<{ title: string; resolution_note: string | null }>(sql`
    SELECT t.subject AS title, t.resolution_note AS resolution_note
    FROM tickets t
    JOIN ticket_categories c ON c.id = t.category_id AND c.partner_id = ${partnerId}
    WHERE t.org_id = ${orgId}
      AND t.category_id = ${categoryId}
      AND t.status = 'resolved'
      AND t.id <> ${ticketId}
      AND t.deleted_at IS NULL
    ORDER BY t.resolved_at DESC NULLS LAST
    LIMIT ${MAX_SIMILAR_RESOLVED_TICKETS}
  `);

  return rows.map((row) => ({ title: row.title, resolutionNote: row.resolution_note }));
}

/**
 * DB-touching wrapper. Called from `runLoop.ts`'s `loadRunContext`, which
 * already runs inside a system DB context (see that module's header) — no
 * context management here.
 *
 * Returns `null` when the ticket is missing, soft-deleted (`deletedAt IS NOT
 * NULL` — a ticket removed from every staff/portal surface must not still
 * reach the model), or not (or no longer) in `orgId` — same "moved/deleted
 * reads as absent" posture `loadRunContext` already applies to `device`/
 * `alert`.
 *
 * The two P2-4 sections load CONCURRENTLY via `Promise.allSettled`, isolated
 * from each other and from the base ticket/comments read above them — a
 * rejection in either is reported (`reportLoaderFailure`) and degrades that
 * section to absent, never aborting the whole context load. When the ticket
 * actually had a `deviceId`/`categoryId` for the rejected section, the
 * corresponding `linkedDeviceUnavailable`/`similarResolvedTicketsUnavailable`
 * flag is also set — see `TicketRunContext`'s docstring on why absence and
 * failure must stay distinguishable to the model.
 */
export async function loadTicketContext(ticketId: string, orgId: string): Promise<TicketRunContext | null> {
  const [ticketRow] = await db
    .select({
      id: tickets.id,
      subject: tickets.subject,
      description: tickets.description,
      status: tickets.status,
      priority: tickets.priority,
      category: tickets.category,
      tags: tickets.tags,
      dueDate: tickets.dueDate,
      deviceId: tickets.deviceId,
      categoryId: tickets.categoryId,
    })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
    .limit(1);
  if (!ticketRow) return null;

  // Human, public, non-deleted comments only — see this module's header.
  // NOTE: authorType (a role label), never authorName — see
  // `TicketContextComment`'s docstring for why that column is excluded.
  const commentRows = await db
    .select({
      authorType: ticketComments.authorType,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(and(
      eq(ticketComments.ticketId, ticketId),
      eq(ticketComments.isPublic, true),
      eq(ticketComments.originPrincipalKind, HUMAN_ORIGIN_KIND),
      isNull(ticketComments.agentRunId),
      isNull(ticketComments.deletedAt),
    ))
    .orderBy(desc(ticketComments.createdAt))
    .limit(TICKET_CONTEXT_MAX_COMMENTS);

  const row = ticketRow as RawTicketRow;
  const [linkedDeviceResult, similarTicketsResult] = await Promise.allSettled([
    row.deviceId ? loadLinkedDeviceContext(row.deviceId, orgId) : Promise.resolve(null),
    row.categoryId ? loadSimilarResolvedTickets(row.id, row.categoryId, orgId) : Promise.resolve([]),
  ]);

  let linkedDevice: RawLinkedDevice | null = null;
  // Only settable `true` when the ticket actually HAD a deviceId — the
  // Promise.allSettled branch above never even calls the loader otherwise
  // (it resolves `null` directly), so a rejection here implies `row.deviceId`
  // was set. The explicit check is defensive documentation of that
  // invariant, not load-bearing on its own.
  let linkedDeviceUnavailable = false;
  if (linkedDeviceResult.status === 'fulfilled') {
    linkedDevice = linkedDeviceResult.value;
  } else {
    reportLoaderFailure(orgId, 'linkedDevice', linkedDeviceResult.reason);
    if (row.deviceId) linkedDeviceUnavailable = true;
  }

  let similarResolvedTickets: RawSimilarResolvedTicket[] = [];
  let similarResolvedTicketsUnavailable = false;
  if (similarTicketsResult.status === 'fulfilled') {
    similarResolvedTickets = similarTicketsResult.value;
  } else {
    reportLoaderFailure(orgId, 'similarResolvedTickets', similarTicketsResult.reason);
    if (row.categoryId) similarResolvedTicketsUnavailable = true;
  }

  return assembleTicketContext({
    ticket: row,
    comments: commentRows as RawCommentRow[],
    linkedDevice,
    linkedDeviceUnavailable,
    similarResolvedTickets,
    similarResolvedTicketsUnavailable,
  });
}
