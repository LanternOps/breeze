/**
 * Bounded 7-day org context for a `narrative`-profile agent run (Phase 2
 * wave P2-3, weekly org narrative — task 5).
 *
 * ## Why the context is SYSTEM-BUILT
 *
 * A narrative run has an EMPTY tool floor: the model cannot drill into
 * anything. Every number it may write about is assembled here, by
 * hand-written org-pinned statements, and handed to it in one bounded
 * object. That makes the run reproducible (the same week produces the same
 * context) and keeps a weekly, unattended, customer-facing report from
 * becoming an open-ended read of the tenant's data. Same posture as
 * `sweepEvidence.ts`, one level up: there the model picks findings from a
 * fixed evidence set; here it writes prose over a fixed number set.
 *
 * ## The four properties this module holds
 *
 *  - **Numbers, closed labels, and operator-authored NAMES only.** Nothing
 *    a customer or an end user typed reaches the prompt: no alert message or
 *    title, no ticket subject or body, no sweep finding title/detail/
 *    evidence, no intent arguments/reason/result, no backup error log, no
 *    verdict rationale, no reliability raw JSON. The ONLY strings that cross
 *    are counts' labels (closed enums) and names an MSP operator chose —
 *    alert rule names, ticket category names, the org and partner names —
 *    each `\p{C}`-stripped and clamped through the shared
 *    `sanitizeSweepText` (see `sanitizeName`).
 *
 *  - **Every jsonb read is a closed whitelist.** `ai_agent_runs.outcome` is
 *    an open container, so its arrays are expanded only under a
 *    `jsonb_typeof(...) = 'array'` guard and every value that comes back is
 *    bucketed against a shared enum (`AI_SWEEP_KINDS`,
 *    `AI_SWEEP_SEVERITIES`, `SweepProposalDisposition`, `AgentRunVerdict`).
 *    A value that is not in the enum is DROPPED — never echoed into the
 *    prompt as a key of its own.
 *
 *  - **Honest availability.** "Measured zero" and "could not measure" are
 *    different facts and are reported differently: each block carries an
 *    `available` flag, and `unavailable` names every input that is missing.
 *    Two entries are always there because they are STRUCTURALLY
 *    unmeasurable: `alerts` has no `suppressed_at` (only a current-state
 *    suppressed count exists) and `devices` keeps no status history (so no
 *    online/offline delta can be derived — `fleet.deltaAvailable` is a
 *    `false` literal, not a maybe). A loader that REJECTS adds its block
 *    name; `Promise.allSettled` keeps one dead table from costing the whole
 *    narrative.
 *
 *  - **Bounded once, over the whole thing.** `NARRATIVE_TOP_N` caps the two
 *    variable-length lists (loaders fetch N+1 so the cap is OBSERVABLE —
 *    a bare `LIMIT N` would have Postgres discard the overflow before the
 *    assembler could see it, the bug fixed in `anomalyContext.ts`, #3828),
 *    and `NARRATIVE_CONTEXT_HARD_LIMIT_BYTES` is then enforced over
 *    `JSON.stringify` of the ENTIRE context (byte-based, like
 *    `anomalyContext.ts`), never per array. With every name clamped to 256
 *    chars the caps alone already keep the context near 8 KiB, so the byte
 *    ceiling is a backstop against future field growth rather than a
 *    routine event — which is exactly why `assembleNarrativeContext` takes
 *    an optional `limitBytes`: the trim ORDER has to stay provable.
 *
 * ## Tenancy
 *
 * `loadNarrativeContext` is called from the narrative run's context loader,
 * which already holds a SYSTEM DB context (full RLS bypass) — no context
 * management here, matching `loadSweepEvidence`/`loadAnomalyContext`. That
 * makes the org predicate in every statement below the ONLY thing keeping
 * one tenant's narrative out of another tenant's rows, so every statement
 * pins the org on its PRIMARY table AND on every tenant-bearing table it
 * joins.
 *
 * Two joins are partner-axis rather than org-axis, and both resolve the
 * partner from THIS org's row (never from the caller):
 *
 *  - an alert's rule owner is admitted only when the rule is this org's OR
 *    partner-wide for this org's partner (`org_id IS NULL AND partner_id =
 *    $partner`) — partner-wide alert rules are the norm for an MSP (epic
 *    #2135), so an org-only join would blank out most rule names;
 *  - `ticket_categories` is a partner-owned table with no `org_id` at all,
 *    so its join carries `c.partner_id = $partner`.
 *
 * When the header statement itself fails, `partnerId` stays `null` and both
 * clauses FAIL CLOSED (`partner_id = NULL` admits nothing), which is why the
 * header rejection is a reported `unavailable` entry rather than a throw.
 *
 * `assembleNarrativeContext` is the pure core (fixture-testable, no DB) that
 * `loadNarrativeContext` wraps with the actual reads.
 */
import { sql, type SQL } from 'drizzle-orm';

import {
  AI_ALERT_VERDICT_CLASSIFICATIONS,
  AI_SWEEP_KINDS,
  AI_SWEEP_SEVERITIES,
  type AgentRunVerdict,
  type AiAlertVerdictClassification,
  type AiSweepKind,
  type AiSweepSeverity,
} from '@breeze/shared';

import { actionIntentStatusEnum } from '../../db/schema/actionIntents';
import type { AiAgentFixWatchState } from '../../db/schema/aiAgentFixWatches';
import { OUTSTANDING_DEVICE_PATCH_STATUSES } from '../../db/schema/patches';
import { captureException } from '../sentry';
import { getSecurityPostureTrend } from '../securityPosture';
// Value import, and deliberately so: `runnerPrompt.ts` has NO runtime imports
// of its own (both of its imports are `import type`), so borrowing this one
// function pulls in nothing, and A6's `import type { NarrativeContext }` back
// the other way is erased at compile time — no cycle in either direction.
import { sanitizeSweepText } from './runnerPrompt';
import type { SweepProposalDisposition } from './sweepFindings';

// Late-bound namespace import (NOT `const { db } = dbModule`): destructuring
// at module scope freezes the binding at import time, before a test's
// `vi.mock('../../db')` factory can be observed. Same idiom as
// `sweepEvidence.ts`.
import * as dbModule from '../../db';

/** Aim: the serialized context should fit under this many UTF-8 bytes — see
 *  this module's header on why the caps normally get there first. */
export const NARRATIVE_CONTEXT_HARD_LIMIT_BYTES = 16 * 1024;

/** How many entries of each variable-length list reach the prompt. Loaders
 *  fetch `NARRATIVE_TOP_N + 1` so the cap is observable. */
export const NARRATIVE_TOP_N = 10;

/** Defensive clamp on every operator-authored name. `alert_rules.name` is
 *  varchar(200) and `ticket_categories.name` varchar(100) today, so this is
 *  headroom, not a live truncation. `sanitizeSweepText` appends an ellipsis
 *  when it truncates, so a clamped name renders as at most 256 chars. */
const MAX_NAME_CHARS = 255;

/** Window length. "The previous 7 days ending now" — the narrative schedule
 *  is weekly-only (see the P2-3 plan), so consecutive runs tile the calendar
 *  without a gap or an overlap. */
const PERIOD_DAYS = 7;

/**
 * The two inputs §4.3 of the spec assumed exist and that the schema simply
 * cannot produce. They are constants, not loader outcomes: no amount of
 * healthy database makes them measurable.
 *
 *  - `alerts.suppressedInWindow` — `alerts` has `suppressed_until` but no
 *    `suppressed_at`, so "suppressed during this week" is underivable; the
 *    context reports the CURRENT suppressed count instead.
 *  - `fleet.onlineOfflineDelta` — `devices.status` is current state with no
 *    history table, so week-over-week movement cannot be computed; the
 *    context reports current state + enrolled-in-window + mean `uptime_7d`.
 */
const STRUCTURALLY_UNAVAILABLE = ['alerts.suppressedInWindow', 'fleet.onlineOfflineDelta'] as const;

// ---------------------------------------------------------------------------
// Closed whitelists. Declared as `satisfies Record<Union, number>` objects so
// adding a member to any of these unions is a COMPILE error here rather than
// a silently dropped bucket at runtime.
// ---------------------------------------------------------------------------

const SWEEP_PROPOSAL_DISPOSITIONS = {
  intent_created: 0, refused: 0, cap_reached: 0, error: 0,
} satisfies Record<SweepProposalDisposition, number>;

const AGENT_RUN_VERDICTS = {
  remediated: 0, needs_attention: 0, partial: 0, no_action: 0,
} satisfies Record<AgentRunVerdict, number>;

const SWEEP_PROPOSAL_DISPOSITION_KEYS = Object.keys(SWEEP_PROPOSAL_DISPOSITIONS) as SweepProposalDisposition[];
const AGENT_RUN_VERDICT_KEYS = Object.keys(AGENT_RUN_VERDICTS) as AgentRunVerdict[];

/** Fix-watch states the narrative reports on. `pending` (not yet observed)
 *  and `cancelled` are deliberately absent — neither is a verdict. */
const REPORTED_WATCH_STATES = {
  held_qualified: 'heldQualified', recurred: 'recurred', inconclusive: 'inconclusive', watching: 'watching',
} as const satisfies Partial<Record<AiAgentFixWatchState, keyof NarrativeContext['fixes']['watches']>>;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface NarrativeTopRule { name: string; count: number; highOrCritical: number }
export interface NarrativeTicketCategory { name: string; opened: number; closed: number }

export interface NarrativeContext {
  org: { name: string; partnerName: string; timezone: string; deviceCount: number; siteCount: number };
  /** ISO-8601 with the org timezone's offset — see `zonedIso`. */
  period: { start: string; end: string };
  alerts: {
    available: boolean;
    created: number;
    resolved: number;
    /** Resolved with no `resolved_by` — nobody clicked, the condition cleared. */
    autoResolved: number;
    critical: number;
    /** CURRENT state, not a window count — see `STRUCTURALLY_UNAVAILABLE`. */
    currentlySuppressed: number;
    topRules: NarrativeTopRule[];
    topRulesTruncated: boolean;
    verdicts: Record<AiAlertVerdictClassification, number>;
    feedbackUp: number;
    feedbackDown: number;
    groupsCreated: number;
  };
  sweeps: {
    available: boolean;
    runs: number;
    completed: number;
    failed: number;
    findingsByKind: Record<AiSweepKind, number>;
    findingsBySeverity: Record<AiSweepSeverity, number>;
    proposals: Record<SweepProposalDisposition, number>;
    evidenceTruncatedRuns: number;
  };
  fixes: {
    available: boolean;
    runVerdicts: Record<AgentRunVerdict, number>;
    intentsByStatus: Record<string, number>;
    watches: { heldQualified: number; recurred: number; inconclusive: number; watching: number };
  };
  tickets: {
    available: boolean;
    opened: number;
    closed: number;
    openedHigh: number;
    byCategory: NarrativeTicketCategory[];
    byCategoryTruncated: boolean;
  };
  patching: {
    /** False when NEITHER posture snapshot exists — the counters below are
     *  still measured (they come from a different statement). */
    available: boolean;
    patchScoreThisWeek: number | null;
    patchScorePriorWeek: number | null;
    overallScoreThisWeek: number | null;
    pendingPatches: number;
    devicesPending: number;
    installed7d: number;
  };
  backups: {
    available: boolean;
    ok: number;
    failed: number;
    partial: number;
    /** `ok + failed + partial` — jobs that reached an outcome this week. */
    terminal: number;
    /** `null`, never 0, when nothing reached a terminal state. */
    successRatePct: number | null;
    devicesFailed: number;
  };
  fleet: {
    available: boolean;
    total: number;
    online: number;
    offline: number;
    decommissioned: number;
    enrolled7d: number;
    stale: number;
    avgUptime7dPct: number | null;
    /** Literal `false`: there is no device status history to diff. */
    deltaAvailable: false;
  };
  /** The two structural entries above, then one entry per input that could
   *  not be measured this run. The prompt renders "(not measured)" for each. */
  unavailable: string[];
  /** True only when the WHOLE-context byte ceiling forced entries out. The
   *  per-list `*Truncated` flags cover the top-N caps. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Loader results. One field per loader; `null` means that loader REJECTED,
// which is a different fact from "it ran and measured zero".
// ---------------------------------------------------------------------------

export interface RawOrgHeader {
  name: string;
  partnerName: string;
  timezone: string;
  deviceCount: number;
  siteCount: number;
}

export interface RawAlertInputs {
  created: number;
  resolved: number;
  autoResolved: number;
  critical: number;
  currentlySuppressed: number;
  /** Up to `NARRATIVE_TOP_N + 1`, busiest first. */
  topRules: NarrativeTopRule[];
  verdicts: Record<AiAlertVerdictClassification, number>;
  feedbackUp: number;
  feedbackDown: number;
  groupsCreated: number;
}

export interface RawSweepInputs {
  runs: number;
  completed: number;
  failed: number;
  findingsByKind: Record<AiSweepKind, number>;
  findingsBySeverity: Record<AiSweepSeverity, number>;
  proposals: Record<SweepProposalDisposition, number>;
  evidenceTruncatedRuns: number;
}

export interface RawFixInputs {
  runVerdicts: Record<AgentRunVerdict, number>;
  intentsByStatus: Record<string, number>;
  watches: NarrativeContext['fixes']['watches'];
}

export interface RawTicketInputs {
  opened: number;
  closed: number;
  openedHigh: number;
  /** Up to `NARRATIVE_TOP_N + 1`, busiest first. */
  byCategory: NarrativeTicketCategory[];
}

export interface RawPatchingInputs {
  patchScoreThisWeek: number | null;
  patchScorePriorWeek: number | null;
  overallScoreThisWeek: number | null;
  pendingPatches: number;
  devicesPending: number;
  installed7d: number;
}

/** `terminal` and `successRatePct` are DERIVED by the assembler, not loaded —
 *  a loader that reported its own total could disagree with its parts. */
export interface RawBackupInputs {
  ok: number;
  failed: number;
  partial: number;
  devicesFailed: number;
}

export interface RawFleetInputs {
  total: number;
  online: number;
  offline: number;
  decommissioned: number;
  enrolled7d: number;
  stale: number;
  avgUptime7dPct: number | null;
}

export interface RawNarrativeInputs {
  period: { start: string; end: string };
  org: RawOrgHeader | null;
  alerts: RawAlertInputs | null;
  sweeps: RawSweepInputs | null;
  fixes: RawFixInputs | null;
  tickets: RawTicketInputs | null;
  patching: RawPatchingInputs | null;
  backups: RawBackupInputs | null;
  fleet: RawFleetInputs | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

/**
 * Neutralize one operator-authored name before it reaches the prompt.
 *
 * `sanitizeSweepText` (runnerPrompt.ts) is the repo's one implementation of
 * this rule and is reused rather than re-derived: every control/format
 * codepoint (`\p{C}` — C0, DEL, C1 and the bidi overrides that visually
 * reorder a line) becomes a space, runs of whitespace collapse, and the
 * result is truncated. The reason is the same one it was written for: the
 * narrative task turn is line-oriented, so a rule named
 * `Disk low\n- FINANCE-DC is on fire` would otherwise FORGE a line.
 */
function sanitizeName(value: string): string {
  return sanitizeSweepText(value, MAX_NAME_CHARS);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // `bigint`/`numeric`/`real` columns come back as strings from postgres-js.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function count(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

/** One decimal place — these are human-facing percentages and the extra
 *  digits are pure byte-budget waste. */
function roundedOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed * 10) / 10;
}

/**
 * ISO-8601 rendered in `timeZone` rather than in UTC — the period is what
 * the narrative's first line quotes to an IT decision-maker, and "the week
 * ending 29 Aug 08:00" has to mean their Monday, not GMT's.
 *
 * Falls back to the plain UTC instant when the stored zone is not one ICU
 * knows: a partner row can hold any string, and a context loader is the
 * wrong place to discover that by throwing.
 */
function zonedIso(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
    // `longOffset` renders as `GMT`, `GMT-04:00` or `GMT+05:30`.
    const raw = part('timeZoneName').replace('GMT', '');
    const offset = raw === '' ? '+00:00' : raw;
    if (!/^[+-]\d{2}:\d{2}$/.test(offset)) return date.toISOString();
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
  } catch {
    return date.toISOString();
  }
}

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

/**
 * Pure assembly from already-loaded numbers. Exported so unit tests can drive
 * every cap/trim/availability branch deterministically without a DB.
 *
 * `limitBytes` exists ONLY as a testing seam for the trim order: with every
 * name clamped to 256 chars the top-N caps already hold the real context
 * near 8 KiB, so the 16-KiB ceiling would otherwise be an unreachable branch
 * that nothing could prove the behaviour of.
 */
export function assembleNarrativeContext(
  raw: RawNarrativeInputs,
  opts: { limitBytes?: number } = {},
): NarrativeContext {
  const unavailable: string[] = [...STRUCTURALLY_UNAVAILABLE];
  const missing = (block: string): void => { unavailable.push(block); };

  if (!raw.org) missing('org');
  const org = raw.org
    ? {
      name: sanitizeName(raw.org.name),
      partnerName: sanitizeName(raw.org.partnerName),
      timezone: raw.org.timezone,
      deviceCount: raw.org.deviceCount,
      siteCount: raw.org.siteCount,
    }
    : { name: '', partnerName: '', timezone: 'UTC', deviceCount: 0, siteCount: 0 };

  if (!raw.alerts) missing('alerts');
  const topRulesAll = (raw.alerts?.topRules ?? []).map((rule) => ({ ...rule, name: sanitizeName(rule.name) }));
  const alerts: NarrativeContext['alerts'] = {
    available: raw.alerts !== null,
    created: raw.alerts?.created ?? 0,
    resolved: raw.alerts?.resolved ?? 0,
    autoResolved: raw.alerts?.autoResolved ?? 0,
    critical: raw.alerts?.critical ?? 0,
    currentlySuppressed: raw.alerts?.currentlySuppressed ?? 0,
    topRules: topRulesAll.slice(0, NARRATIVE_TOP_N),
    topRulesTruncated: topRulesAll.length > NARRATIVE_TOP_N,
    verdicts: raw.alerts?.verdicts ?? zeroed(AI_ALERT_VERDICT_CLASSIFICATIONS),
    feedbackUp: raw.alerts?.feedbackUp ?? 0,
    feedbackDown: raw.alerts?.feedbackDown ?? 0,
    groupsCreated: raw.alerts?.groupsCreated ?? 0,
  };

  if (!raw.sweeps) missing('sweeps');
  const sweeps: NarrativeContext['sweeps'] = {
    available: raw.sweeps !== null,
    runs: raw.sweeps?.runs ?? 0,
    completed: raw.sweeps?.completed ?? 0,
    failed: raw.sweeps?.failed ?? 0,
    findingsByKind: raw.sweeps?.findingsByKind ?? zeroed(AI_SWEEP_KINDS),
    findingsBySeverity: raw.sweeps?.findingsBySeverity ?? zeroed(AI_SWEEP_SEVERITIES),
    proposals: raw.sweeps?.proposals ?? zeroed(SWEEP_PROPOSAL_DISPOSITION_KEYS),
    evidenceTruncatedRuns: raw.sweeps?.evidenceTruncatedRuns ?? 0,
  };

  if (!raw.fixes) missing('fixes');
  const fixes: NarrativeContext['fixes'] = {
    available: raw.fixes !== null,
    runVerdicts: raw.fixes?.runVerdicts ?? zeroed(AGENT_RUN_VERDICT_KEYS),
    intentsByStatus: raw.fixes?.intentsByStatus ?? zeroed(actionIntentStatusEnum),
    watches: raw.fixes?.watches ?? { heldQualified: 0, recurred: 0, inconclusive: 0, watching: 0 },
  };

  if (!raw.tickets) missing('tickets');
  const byCategoryAll = (raw.tickets?.byCategory ?? []).map((row) => ({ ...row, name: sanitizeName(row.name) }));
  const tickets: NarrativeContext['tickets'] = {
    available: raw.tickets !== null,
    opened: raw.tickets?.opened ?? 0,
    closed: raw.tickets?.closed ?? 0,
    openedHigh: raw.tickets?.openedHigh ?? 0,
    byCategory: byCategoryAll.slice(0, NARRATIVE_TOP_N),
    byCategoryTruncated: byCategoryAll.length > NARRATIVE_TOP_N,
  };

  // Two distinct failures, reported distinctly: the loader threw (no
  // counters either) versus the loader ran but nobody has ever computed a
  // posture snapshot for this org (counters fine, scores absent).
  if (!raw.patching) missing('patching');
  const hasPostureScores = raw.patching !== null
    && (raw.patching.patchScoreThisWeek !== null || raw.patching.patchScorePriorWeek !== null);
  if (raw.patching && !hasPostureScores) missing('patching.postureScores');
  const patching: NarrativeContext['patching'] = {
    available: hasPostureScores,
    patchScoreThisWeek: raw.patching?.patchScoreThisWeek ?? null,
    patchScorePriorWeek: raw.patching?.patchScorePriorWeek ?? null,
    overallScoreThisWeek: raw.patching?.overallScoreThisWeek ?? null,
    pendingPatches: raw.patching?.pendingPatches ?? 0,
    devicesPending: raw.patching?.devicesPending ?? 0,
    installed7d: raw.patching?.installed7d ?? 0,
  };

  if (!raw.backups) missing('backups');
  const terminal = raw.backups ? raw.backups.ok + raw.backups.failed + raw.backups.partial : 0;
  const backups: NarrativeContext['backups'] = {
    available: raw.backups !== null,
    ok: raw.backups?.ok ?? 0,
    failed: raw.backups?.failed ?? 0,
    partial: raw.backups?.partial ?? 0,
    terminal,
    successRatePct: terminal > 0 ? Math.round(((raw.backups?.ok ?? 0) / terminal) * 1000) / 10 : null,
    devicesFailed: raw.backups?.devicesFailed ?? 0,
  };

  if (!raw.fleet) missing('fleet');
  const fleet: NarrativeContext['fleet'] = {
    available: raw.fleet !== null,
    total: raw.fleet?.total ?? 0,
    online: raw.fleet?.online ?? 0,
    offline: raw.fleet?.offline ?? 0,
    decommissioned: raw.fleet?.decommissioned ?? 0,
    enrolled7d: raw.fleet?.enrolled7d ?? 0,
    stale: raw.fleet?.stale ?? 0,
    avgUptime7dPct: raw.fleet?.avgUptime7dPct ?? null,
    deltaAvailable: false,
  };

  const ctx: NarrativeContext = {
    org, period: raw.period, alerts, sweeps, fixes, tickets, patching, backups, fleet,
    unavailable, truncated: false,
  };

  // Byte ceiling, measured over the WHOLE serialized context. Each pass drops
  // exactly one WHOLE entry — never a partial entry and never a sliced name,
  // because the model must be able to trust every entry it CAN see. Order is
  // deliberate: a ticket-category breakdown is the least load-bearing list in
  // the report, the noisiest alert rules are the story.
  const limit = opts.limitBytes ?? NARRATIVE_CONTEXT_HARD_LIMIT_BYTES;
  while (Buffer.byteLength(JSON.stringify(ctx), 'utf8') > limit) {
    if (ctx.tickets.byCategory.length > 0) {
      ctx.tickets.byCategory = ctx.tickets.byCategory.slice(0, -1);
      ctx.tickets.byCategoryTruncated = true;
    } else if (ctx.alerts.topRules.length > 0) {
      ctx.alerts.topRules = ctx.alerts.topRules.slice(0, -1);
      ctx.alerts.topRulesTruncated = true;
    } else {
      // Nothing left to drop: the residual bytes are the envelope itself
      // (fixed-shape counters). Bail rather than spin.
      ctx.truncated = true;
      break;
    }
    ctx.truncated = true;
  }

  return ctx;
}

/**
 * One place every loader failure is reported from — `settled` below and the
 * posture-service catch inside `loadPatching`.
 *
 * A context loader that fails silently is the worst of both worlds: the run
 * still produces a narrative, the prompt says "(not measured)", and nobody
 * ever learns that a table or a service is broken. `unavailable` tells the
 * MODEL; this tells the OPERATORS. `console.warn` (not `error`) because the
 * run itself is still healthy and completes — matching how `runLoop.ts`
 * grades a context-load failure that it recovers from. Sentry tags mirror the
 * `service`/`operation` shape `agentService.ts` uses.
 */
function reportLoaderFailure(orgId: string, loader: string, error: unknown): void {
  console.warn('[aiAgentNarrativeContext] context loader failed; block reported as unavailable', {
    orgId, loader, error,
  });
  captureException(error, undefined, {
    service: 'aiAgents',
    operation: 'loadNarrativeContext',
    loader,
    orgId,
  });
}

// ---------------------------------------------------------------------------
// Loaders. Raw SQL (not the Drizzle builder) for the same two reasons as
// `sweepEvidence.ts`: several need `FILTER (WHERE ...)` / `jsonb_array_elements`
// which the builder cannot express, and a hand-written statement is the only
// form whose tenancy predicate a unit test can actually READ back.
// ---------------------------------------------------------------------------

/** Read `N + 1` — see this module's header on observable truncation. */
const TOP_N_FETCH_LIMIT = NARRATIVE_TOP_N + 1;

/**
 * The period bounds AS ISO-8601 STRINGS, never as `Date` objects.
 *
 * A JS `Date` interpolated into a drizzle `sql` template and executed through
 * `db.execute` is not serialisable by the postgres-js driver on this path: the
 * Bind message reaches `Buffer.byteLength(<Date>)` and throws
 * `TypeError: The "string" argument must be of type string ... Received an
 * instance of Date`. Worse than a normal query error — postgres-js raises it
 * OUTSIDE the awaited promise, so `settled()` cannot contain it and the whole
 * run dies on an unhandled rejection while every block is also marked
 * `unavailable`. An ISO string binds as an unspecified-type parameter, which
 * Postgres coerces to `timestamp`/`timestamptz` from the comparison's other
 * side. Proven live in `aiAgentNarrative.integration.test.ts` — the unit
 * suite mocks `db` and can never see this.
 */
type Window = { start: string; end: string };

/** Every loader's org identity. `partnerId` is `null` only when the header
 *  statement itself failed, in which case both partner-axis clauses admit
 *  nothing (fail closed). */
type Scope = { orgId: string; partnerId: string | null };

async function query<T extends Record<string, unknown>>(statement: SQL): Promise<T[]> {
  const rows = await dbModule.db.execute<T>(statement);
  // drizzle types a postgres-js result as `Assume<T, Row>[]` — structurally the
  // same shape as `T`, just branded — and its RowList is not a plain array, so
  // the spread copies it out and the assertion drops the brand. Same reason
  // `sweepEvidence.ts` writes `const list = [...rows]` at each call site;
  // hoisting it into one helper is what makes the assertion explicit.
  return [...rows] as T[];
}

/** Fold a `(label, count)` histogram onto a closed whitelist. Anything not
 *  in `keys` is DROPPED — the label came out of an open jsonb container or a
 *  text column, and echoing it would put an unvetted string in the prompt. */
function histogram<K extends string>(
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: readonly K[],
  labelColumn: string,
): Record<K, number> {
  const out = zeroed(keys);
  const allowed = new Set<string>(keys);
  for (const row of rows) {
    const label = row[labelColumn];
    if (typeof label !== 'string' || !allowed.has(label)) continue;
    out[label as K] += count(row.count);
  }
  return out;
}

type HeaderRow = {
  org_name: string | null; partner_id: string | null; partner_name: string | null;
  timezone: string | null; device_count: number | string | null; site_count: number | string | null;
};

/**
 * The org header AND the partner identity every other partner-axis join
 * needs. Runs FIRST and alone: the two clauses below cannot be built without
 * `partner_id`, and the period cannot be rendered without the timezone.
 *
 * `organizations` is the id-keyed tenancy shape, so its pin is `o.id`; the
 * partner row is reached only through THIS org's `partner_id`, never through
 * a caller-supplied one. Ephemeral (Quick Support) devices are excluded from
 * the count for the same reason `sweepEvidence.ts` excludes them: a one-off
 * support enrolment is not part of the fleet a weekly report describes.
 */
async function loadHeader(orgId: string): Promise<RawOrgHeader & { partnerId: string | null }> {
  const rows = await query<HeaderRow>(sql`
    SELECT o.name AS org_name,
           o.partner_id AS partner_id,
           p.name AS partner_name,
           p.timezone AS timezone,
           (SELECT COUNT(*) FROM devices d WHERE d.org_id = ${orgId} AND d.is_ephemeral = false)::int AS device_count,
           (SELECT COUNT(*) FROM sites s WHERE s.org_id = ${orgId})::int AS site_count
    FROM organizations o
    JOIN partners p ON p.id = o.partner_id
    WHERE o.id = ${orgId}
  `);
  const row = rows[0];
  if (!row) throw new Error('narrative context: organization not found');
  return {
    name: row.org_name ?? '',
    partnerName: row.partner_name ?? '',
    timezone: row.timezone ?? 'UTC',
    deviceCount: count(row.device_count),
    siteCount: count(row.site_count),
    partnerId: row.partner_id,
  };
}

/**
 * Alerts: four statements, all pinned on `alerts.org_id` (`alerts` carries a
 * direct `org_id`, tenancy shape 1).
 *
 * `resolved_by IS NULL` on a resolved alert is what "auto-resolved" means in
 * this schema — nobody clicked, the condition cleared and the reaper closed
 * it. `currently_suppressed` is a CURRENT-state count because there is no
 * `suppressed_at` to window on (see `STRUCTURALLY_UNAVAILABLE`).
 */
async function loadAlerts(scope: Scope, window: Window): Promise<RawAlertInputs> {
  const { orgId, partnerId } = scope;
  const { start, end } = window;

  const [lifecycle] = await query<{
    created: number | string | null; resolved: number | string | null; auto_resolved: number | string | null;
    critical: number | string | null; currently_suppressed: number | string | null;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE a.created_at >= ${start} AND a.created_at < ${end})::int AS created,
      COUNT(*) FILTER (WHERE a.resolved_at >= ${start} AND a.resolved_at < ${end})::int AS resolved,
      COUNT(*) FILTER (WHERE a.resolved_at >= ${start} AND a.resolved_at < ${end} AND a.resolved_by IS NULL)::int AS auto_resolved,
      COUNT(*) FILTER (WHERE a.created_at >= ${start} AND a.created_at < ${end} AND a.severity = 'critical')::int AS critical,
      COUNT(*) FILTER (WHERE a.status = 'suppressed')::int AS currently_suppressed
    FROM alerts a
    WHERE a.org_id = ${orgId}
      AND (a.created_at >= ${start} OR a.resolved_at >= ${start} OR a.status = 'suppressed')
  `);

  // LEFT JOIN, with the owner admission INSIDE the ON clause: an alert whose
  // rule belongs to neither this org nor this org's partner degrades to "no
  // rule" (and is then dropped by the HAVING) instead of surfacing a foreign
  // tenant's rule name. A rule with `org_id IS NULL` is partner-wide (epic
  // #2135) and legitimately owns this org's alerts.
  const topRules = await query<{ rule_name: string | null; count: number | string | null; high_or_critical: number | string | null }>(sql`
    SELECT r.name AS rule_name,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE a.severity IN ('critical', 'high'))::int AS high_or_critical
    FROM alerts a
    LEFT JOIN alert_rules r ON r.id = a.rule_id
      AND (r.org_id = ${orgId} OR (r.org_id IS NULL AND r.partner_id = ${partnerId}))
    WHERE a.org_id = ${orgId}
      AND a.created_at >= ${start} AND a.created_at < ${end}
    GROUP BY r.name
    HAVING r.name IS NOT NULL
    ORDER BY COUNT(*) DESC, r.name ASC
    LIMIT ${TOP_N_FETCH_LIMIT}
  `);

  // `ai_alert_verdicts` carries its own `org_id` (shape 1), so the histogram
  // needs no join to `alerts` — which also keeps correlation-GROUP verdicts
  // (alert_id NULL) in the count. `superseded_by IS NULL` keeps one alert
  // from being counted once per re-verdict.
  const verdictRows = await query<{
    classification: string | null; count: number | string | null;
    feedback_up: number | string | null; feedback_down: number | string | null;
  }>(sql`
    SELECT v.classification AS classification,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE v.feedback = 'up')::int AS feedback_up,
           COUNT(*) FILTER (WHERE v.feedback = 'down')::int AS feedback_down
    FROM ai_alert_verdicts v
    WHERE v.org_id = ${orgId}
      AND v.superseded_by IS NULL
      AND v.created_at >= ${start} AND v.created_at < ${end}
    GROUP BY v.classification
  `);

  const [groups] = await query<{ groups_created: number | string | null }>(sql`
    SELECT COUNT(*)::int AS groups_created
    FROM alert_correlation_groups g
    WHERE g.org_id = ${orgId}
      AND g.created_at >= ${start} AND g.created_at < ${end}
  `);

  return {
    created: count(lifecycle?.created),
    resolved: count(lifecycle?.resolved),
    autoResolved: count(lifecycle?.auto_resolved),
    critical: count(lifecycle?.critical),
    currentlySuppressed: count(lifecycle?.currently_suppressed),
    topRules: topRules.map((row) => ({
      name: row.rule_name ?? '',
      count: count(row.count),
      highOrCritical: count(row.high_or_critical),
    })),
    verdicts: histogram(verdictRows, AI_ALERT_VERDICT_CLASSIFICATIONS, 'classification'),
    feedbackUp: verdictRows.reduce((sum, row) => sum + count(row.feedback_up), 0),
    feedbackDown: verdictRows.reduce((sum, row) => sum + count(row.feedback_down), 0),
    groupsCreated: count(groups?.groups_created),
  };
}

/**
 * Sweeps: the previous week's `sweep`-profile runs and what they produced.
 *
 * Windowed on `queued_at` (when the occurrence admitted the run) rather than
 * on `finished_at`, so a run that is still going belongs to the week it was
 * scheduled for.
 *
 * The two array expansions guard with `jsonb_typeof(...) = 'array'` inside a
 * CASE rather than in the WHERE clause: `jsonb_array_elements` is a
 * set-returning function in the FROM list and is NOT guaranteed to be
 * evaluated after the filter, so a malformed `outcome` would raise and take
 * the whole loader down. The CASE turns it into an empty expansion instead.
 */
async function loadSweeps(orgId: string, window: Window): Promise<RawSweepInputs> {
  const { start, end } = window;

  const [runs] = await query<{
    runs: number | string | null; completed: number | string | null;
    failed: number | string | null; evidence_truncated_runs: number | string | null;
  }>(sql`
    SELECT COUNT(*)::int AS runs,
           COUNT(*) FILTER (WHERE r.status = 'completed')::int AS completed,
           COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE r.outcome->>'sweepEvidenceTruncated' = 'true')::int AS evidence_truncated_runs
    FROM ai_agent_runs r
    WHERE r.org_id = ${orgId}
      AND r.profile = 'sweep'
      AND r.queued_at >= ${start} AND r.queued_at < ${end}
  `);

  const findings = await query<{ kind: string | null; severity: string | null; count: number | string | null }>(sql`
    SELECT f.value->>'kind' AS kind,
           f.value->>'severity' AS severity,
           COUNT(*)::int AS count
    FROM ai_agent_runs r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.outcome->'sweepFindings'->'findings') = 'array'
           THEN r.outcome->'sweepFindings'->'findings'
           ELSE '[]'::jsonb END
    ) AS f(value)
    WHERE r.org_id = ${orgId}
      AND r.profile = 'sweep'
      AND r.queued_at >= ${start} AND r.queued_at < ${end}
    GROUP BY 1, 2
  `);

  const proposals = await query<{ disposition: string | null; count: number | string | null }>(sql`
    SELECT p.value->>'disposition' AS disposition,
           COUNT(*)::int AS count
    FROM ai_agent_runs r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.outcome->'sweepProposals') = 'array'
           THEN r.outcome->'sweepProposals'
           ELSE '[]'::jsonb END
    ) AS p(value)
    WHERE r.org_id = ${orgId}
      AND r.profile = 'sweep'
      AND r.queued_at >= ${start} AND r.queued_at < ${end}
    GROUP BY 1
  `);

  return {
    runs: count(runs?.runs),
    completed: count(runs?.completed),
    failed: count(runs?.failed),
    findingsByKind: histogram(findings, AI_SWEEP_KINDS, 'kind'),
    findingsBySeverity: histogram(findings, AI_SWEEP_SEVERITIES, 'severity'),
    proposals: histogram(proposals, SWEEP_PROPOSAL_DISPOSITION_KEYS, 'disposition'),
    evidenceTruncatedRuns: count(runs?.evidence_truncated_runs),
  };
}

/**
 * Fixes: what the agent actually changed. Three independent histograms —
 * run-level verdicts (every profile, not just sweeps), the approval intents
 * the agent asked for, and the fix-watch verdicts that say whether a
 * remediation held.
 */
async function loadFixes(orgId: string, window: Window): Promise<RawFixInputs> {
  const { start, end } = window;

  const verdicts = await query<{ run_verdict: string | null; count: number | string | null }>(sql`
    SELECT r.outcome->>'runVerdict' AS run_verdict,
           COUNT(*)::int AS count
    FROM ai_agent_runs r
    WHERE r.org_id = ${orgId}
      AND r.queued_at >= ${start} AND r.queued_at < ${end}
      AND jsonb_typeof(r.outcome->'runVerdict') = 'string'
    GROUP BY 1
  `);

  const intents = await query<{ status: string | null; count: number | string | null }>(sql`
    SELECT i.status AS status,
           COUNT(*)::int AS count
    FROM action_intents i
    WHERE i.org_id = ${orgId}
      AND i.source = 'ai_agent'
      AND i.created_at >= ${start} AND i.created_at < ${end}
    GROUP BY 1
  `);

  const watches = await query<{ state: string | null; count: number | string | null }>(sql`
    SELECT w.state AS state,
           COUNT(*)::int AS count
    FROM ai_agent_fix_watches w
    WHERE w.org_id = ${orgId}
      AND w.created_at >= ${start} AND w.created_at < ${end}
    GROUP BY 1
  `);

  const byState = histogram(watches, Object.keys(REPORTED_WATCH_STATES) as Array<keyof typeof REPORTED_WATCH_STATES>, 'state');
  return {
    runVerdicts: histogram(verdicts, AGENT_RUN_VERDICT_KEYS, 'run_verdict'),
    intentsByStatus: histogram(intents, actionIntentStatusEnum, 'status'),
    watches: {
      heldQualified: byState.held_qualified,
      recurred: byState.recurred,
      inconclusive: byState.inconclusive,
      watching: byState.watching,
    },
  };
}

/**
 * Tickets: opened/closed volume and the busiest categories.
 *
 * `ticket_categories` is PARTNER-owned (no `org_id` at all), so its join
 * carries `c.partner_id = $partner` — resolved from this org's own row. Soft
 * deleted tickets are excluded (`t.deleted_at IS NULL`) exactly as every
 * staff list does; `ticket_categories` has no soft-delete column of its own.
 */
async function loadTickets(scope: Scope, window: Window): Promise<RawTicketInputs> {
  const { orgId, partnerId } = scope;
  const { start, end } = window;

  const [totals] = await query<{
    opened: number | string | null; closed: number | string | null; opened_high: number | string | null;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE t.created_at >= ${start} AND t.created_at < ${end})::int AS opened,
      COUNT(*) FILTER (WHERE t.closed_at >= ${start} AND t.closed_at < ${end})::int AS closed,
      COUNT(*) FILTER (
        WHERE t.created_at >= ${start} AND t.created_at < ${end}
          AND t.priority IN ('high', 'urgent')
      )::int AS opened_high
    FROM tickets t
    WHERE t.org_id = ${orgId}
      AND t.deleted_at IS NULL
      AND (t.created_at >= ${start} OR t.closed_at >= ${start})
  `);

  const byCategory = await query<{
    category_name: string | null; opened: number | string | null; closed: number | string | null;
  }>(sql`
    SELECT c.name AS category_name,
           COUNT(*) FILTER (WHERE t.created_at >= ${start} AND t.created_at < ${end})::int AS opened,
           COUNT(*) FILTER (WHERE t.closed_at >= ${start} AND t.closed_at < ${end})::int AS closed
    FROM tickets t
    JOIN ticket_categories c ON c.id = t.category_id AND c.partner_id = ${partnerId}
    WHERE t.org_id = ${orgId}
      AND t.deleted_at IS NULL
      AND (t.created_at >= ${start} OR t.closed_at >= ${start})
    GROUP BY c.name
    ORDER BY COUNT(*) FILTER (WHERE t.created_at >= ${start} AND t.created_at < ${end}) DESC, c.name ASC
    LIMIT ${TOP_N_FETCH_LIMIT}
  `);

  return {
    opened: count(totals?.opened),
    closed: count(totals?.closed),
    openedHigh: count(totals?.opened_high),
    byCategory: byCategory.map((row) => ({
      name: row.category_name ?? '',
      opened: count(row.opened),
      closed: count(row.closed),
    })),
  };
}

/** Mean of one numeric key over a set of posture day-buckets, or `null` when
 *  the window holds no bucket at all (which is a real answer: nobody has
 *  computed posture for this org). */
function meanBucket(points: Array<Record<string, string | number>>, key: string): number | null {
  const values = points.map((point) => numberOrNull(point[key])).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/**
 * Patching: the posture score movement plus the raw outstanding/installed
 * counters.
 *
 * The score comes from `getSecurityPostureTrend`'s day buckets and NOT from
 * `patch_compliance_snapshots`, which has no writer at all. The call MUST
 * carry `{ orgId, days: 14 }`: with neither org filter that service returns
 * FLEET-WIDE data (securityPosture.ts), which would put another tenant's
 * numbers into a customer-facing narrative. 14 days is exactly the two
 * windows this compares.
 */
async function loadPatching(orgId: string, window: Window): Promise<RawPatchingInputs> {
  const { start, end } = window;

  // Isolated from the counters below, and NOT merely for tidiness: this is a
  // call into another service, with its own failure modes, and it is the only
  // source of the two posture scores. Letting it reject the whole loader
  // would collapse the honest `patching.postureScores` distinction (scores
  // absent, counters fine) back into a blunt `patching` — losing three
  // measured numbers to a failure that has nothing to do with them.
  //
  // A `null` trend and an EMPTY trend land in the same place on purpose:
  // `meanBucket` returns null for both, the assembler sees two null scores
  // and emits `patching.postureScores`. "The service is down" and "nobody has
  // ever computed posture for this org" are the same fact to the prompt —
  // this number was not measured — and only the operator-facing report above
  // needs to tell them apart.
  let trend: Array<Record<string, string | number>> = [];
  try {
    trend = await getSecurityPostureTrend({ orgId, days: 2 * PERIOD_DAYS });
  } catch (error) {
    reportLoaderFailure(orgId, 'patching.postureScores', error);
  }

  // Day buckets are `YYYY-MM-DD` strings; comparing them as strings is a
  // correct date comparison for that format and avoids re-parsing.
  const thisWeekFrom = start.slice(0, 10);
  const priorWeekFrom = new Date(new Date(start).getTime() - PERIOD_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const dayOf = (point: Record<string, string | number>): string => String(point.timestamp ?? '');
  const thisWeek = trend.filter((point) => dayOf(point) >= thisWeekFrom);
  const priorWeek = trend.filter((point) => dayOf(point) >= priorWeekFrom && dayOf(point) < thisWeekFrom);

  // One statement for both patch counters. The device join is pinned on BOTH
  // sides — `device_patches` carries its own `org_id`, and an unpinned
  // `devices` join would let another tenant's rows through under a system
  // context. Ephemeral devices are excluded, same as everywhere else.
  const [counters] = await query<{
    pending_patches: number | string | null; devices_pending: number | string | null; installed_7d: number | string | null;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE dp.status::text IN ${[...OUTSTANDING_DEVICE_PATCH_STATUSES]})::int AS pending_patches,
      COUNT(DISTINCT dp.device_id) FILTER (WHERE dp.status::text IN ${[...OUTSTANDING_DEVICE_PATCH_STATUSES]})::int AS devices_pending,
      COUNT(*) FILTER (WHERE dp.installed_at >= ${start} AND dp.installed_at < ${end})::int AS installed_7d
    FROM device_patches dp
    JOIN devices d ON d.id = dp.device_id
    WHERE dp.org_id = ${orgId}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND (dp.status::text IN ${[...OUTSTANDING_DEVICE_PATCH_STATUSES]} OR dp.installed_at >= ${start})
  `);

  return {
    patchScoreThisWeek: meanBucket(thisWeek, 'patch_compliance'),
    patchScorePriorWeek: meanBucket(priorWeek, 'patch_compliance'),
    overallScoreThisWeek: meanBucket(thisWeek, 'overall'),
    pendingPatches: count(counters?.pending_patches),
    devicesPending: count(counters?.devices_pending),
    installed7d: count(counters?.installed_7d),
  };
}

/**
 * Backups: the week's terminal job outcomes.
 *
 * `cancelled` is deliberately outside the terminal set — an operator
 * cancelling a job is not a backup outcome, and counting it would drag the
 * success rate down for a decision nobody made about backup health.
 * Windowed on `started_at`, so a job that never started (and therefore never
 * ran this week) contributes nothing.
 */
async function loadBackups(orgId: string, window: Window): Promise<RawBackupInputs> {
  const { start, end } = window;
  const [row] = await query<{
    ok: number | string | null; failed: number | string | null;
    partial: number | string | null; devices_failed: number | string | null;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE bj.status = 'completed')::int AS ok,
      COUNT(*) FILTER (WHERE bj.status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE bj.status = 'partial')::int AS partial,
      COUNT(DISTINCT bj.device_id) FILTER (WHERE bj.status = 'failed')::int AS devices_failed
    FROM backup_jobs bj
    JOIN devices d ON d.id = bj.device_id
    WHERE bj.org_id = ${orgId}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND bj.status IN ('completed', 'failed', 'partial')
      AND bj.started_at >= ${start} AND bj.started_at < ${end}
  `);
  return {
    ok: count(row?.ok),
    failed: count(row?.failed),
    partial: count(row?.partial),
    devicesFailed: count(row?.devices_failed),
  };
}

/**
 * Fleet: current state plus the two things that ARE derivable over the week
 * (enrolments and mean 7-day uptime). No online/offline delta exists — see
 * `STRUCTURALLY_UNAVAILABLE`.
 *
 * `stale` covers never-seen devices as well as long-unseen ones: a bare
 * `last_seen_at < $start` is UNKNOWN for a NULL and would silently drop the
 * stalest machines of all. The NULL branch is gated on `enrolled_at` so a
 * machine enrolled mid-week is not called stale before its first heartbeat
 * could land.
 */
async function loadFleet(orgId: string, window: Window): Promise<RawFleetInputs> {
  const { start, end } = window;
  const [row] = await query<{
    total: number | string | null; online: number | string | null; offline: number | string | null;
    decommissioned: number | string | null; enrolled_7d: number | string | null;
    stale: number | string | null; avg_uptime_7d: number | string | null;
  }>(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE d.status = 'online')::int AS online,
           COUNT(*) FILTER (WHERE d.status = 'offline')::int AS offline,
           COUNT(*) FILTER (WHERE d.status = 'decommissioned')::int AS decommissioned,
           COUNT(*) FILTER (WHERE d.enrolled_at >= ${start} AND d.enrolled_at < ${end})::int AS enrolled_7d,
           COUNT(*) FILTER (
             WHERE d.status <> 'decommissioned'
               AND ((d.last_seen_at IS NULL AND d.enrolled_at < ${start}) OR d.last_seen_at < ${start})
           )::int AS stale,
           AVG(rel.uptime_7d) AS avg_uptime_7d
    FROM devices d
    LEFT JOIN device_reliability rel ON rel.device_id = d.id AND rel.org_id = ${orgId}
    WHERE d.org_id = ${orgId}
      AND d.is_ephemeral = false
  `);
  return {
    total: count(row?.total),
    online: count(row?.online),
    offline: count(row?.offline),
    decommissioned: count(row?.decommissioned),
    enrolled7d: count(row?.enrolled_7d),
    stale: count(row?.stale),
    avgUptime7dPct: roundedOrNull(row?.avg_uptime_7d),
  };
}

/**
 * `Promise.allSettled` over ONE loader: its value on fulfil, `null` on reject.
 * `null` is what the assembler turns into `available: false` plus an
 * `unavailable` entry, so a dead table costs exactly its own block.
 *
 * Applied per loader rather than to the whole list because the loaders are
 * awaited one at a time — see `loadNarrativeContext`. The rejection is
 * reported, never swallowed.
 */
async function settled<T>(orgId: string, loader: string, load: () => Promise<T>): Promise<T | null> {
  const [result] = await Promise.allSettled([load()]);
  if (result?.status === 'fulfilled') return result.value;
  reportLoaderFailure(orgId, loader, result?.reason);
  return null;
}

/**
 * Load the previous 7 days of this org, bounded and honest.
 *
 * The caller already holds a SYSTEM DB context — see this module's header on
 * tenancy. NEVER throws: a rejected loader costs exactly its own block.
 *
 * The header runs FIRST and alone because two joins downstream need its
 * `partner_id` and the period rendering needs its timezone. The remaining
 * seven then run one at a time, each isolated by `settled`.
 *
 * Sequential, not concurrent, and deliberately so: `withSystemDbAccessContext`
 * holds ONE pooled connection inside ONE open transaction for the whole call
 * (db/index.ts — the RLS GUCs are `SET LOCAL`), so issuing sixteen statements
 * at once would only queue them on that same connection. Same shape as
 * `loadSweepEvidence`'s per-kind loop.
 *
 * The limit of that isolation, stated plainly: because every statement shares
 * ONE transaction, a loader that fails with a genuine Postgres ERROR (rather
 * than a timeout or a dropped connection) aborts the transaction, and every
 * loader after it then fails too — `unavailable` will name several blocks
 * where only one is truly broken. Under-reporting availability is the safe
 * direction (the prompt renders "(not measured)"), and true statement-level
 * isolation would mean a savepoint round trip per loader for a failure mode
 * that means the schema is already broken.
 */
export async function loadNarrativeContext(orgId: string): Promise<NarrativeContext> {
  const header = await settled(orgId, 'org', () => loadHeader(orgId));
  const scope: Scope = { orgId, partnerId: header?.partnerId ?? null };

  const end = new Date();
  const start = new Date(end.getTime() - PERIOD_DAYS * 24 * 60 * 60 * 1000);
  // ISO strings, not the `Date`s themselves — see `Window`.
  const window: Window = { start: start.toISOString(), end: end.toISOString() };
  const timezone = header?.timezone ?? 'UTC';

  const alerts = await settled(orgId, 'alerts', () => loadAlerts(scope, window));
  const sweeps = await settled(orgId, 'sweeps', () => loadSweeps(orgId, window));
  const fixes = await settled(orgId, 'fixes', () => loadFixes(orgId, window));
  const tickets = await settled(orgId, 'tickets', () => loadTickets(scope, window));
  const patching = await settled(orgId, 'patching', () => loadPatching(orgId, window));
  const backups = await settled(orgId, 'backups', () => loadBackups(orgId, window));
  const fleet = await settled(orgId, 'fleet', () => loadFleet(orgId, window));

  return assembleNarrativeContext({
    period: { start: zonedIso(start, timezone), end: zonedIso(end, timezone) },
    org: header
      ? {
        name: header.name,
        partnerName: header.partnerName,
        timezone: header.timezone,
        deviceCount: header.deviceCount,
        siteCount: header.siteCount,
      }
      : null,
    alerts, sweeps, fixes, tickets, patching, backups, fleet,
  });
}
