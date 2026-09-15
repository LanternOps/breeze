/**
 * Phase 2 wave P2-2 (scheduled sweeps) — the wire/type contract for the
 * `sweep`-profile run's cron-scheduled admission (`AiAgentScheduleDto` and
 * friends) and its outcome shape (`SweepFindingsOutcome`). Follows the
 * Partner-Wide First playbook (CLAUDE.md): a schedule is either a
 * partner-wide baseline or an org-level override of one, never an
 * independently-owned org row — see `AiAgentScheduleDto.baselineScheduleId`.
 */

/**
 * The fixed catalog of sweep checks a `sweep`-profile run may evaluate.
 * Deliberately a closed enum, not free text: each kind maps to one
 * evaluator in the sweeper (disk usage, agent last-checkin age, pending
 * reboot flag, last backup age, service state, unpatched-critical count),
 * so a schedule can only reference a kind the sweeper actually knows how to
 * run.
 *
 * `expiring_certs` (#5751 W03, #5754) joined the catalog once it gained a real
 * evidence source: the typed `network_monitors.tls_*` columns, fed by the TLS
 * observation the Go agent emits on every HTTPS `http_check`. It is
 * **finding-only** — `SweepProposedAction` is a closed union and there is no
 * safe automated certificate renewal — so it proposes nothing, registers no
 * subject probe, and `isActEligibleSweepKind('expiring_certs')` is false by
 * construction.
 */
export const AI_SWEEP_KINDS = [
  'disk_pressure',
  'stale_agents',
  'pending_reboots',
  'failed_backups',
  'service_down',
  'unpatched_critical',
  'expiring_certs',
] as const;
export type AiSweepKind = (typeof AI_SWEEP_KINDS)[number];

/**
 * Phase 2 wave P2-3 (weekly org narrative) — what a schedule occurrence
 * PRODUCES. `sweep` is every schedule that existed before P2-3 (hence the
 * create schema's default, and the migration's column default): the
 * occurrence fans out one `sweep`-profile run per org. `narrative` fans out
 * one `narrative`-profile run per org instead, producing that org's weekly
 * report rather than findings.
 *
 * The two kinds carry genuinely different admission rules, so the create
 * schema branches on this rather than inferring the kind from an empty
 * `sweepKinds`: a narrative schedule sweeps nothing and must fire exactly
 * once a week (see `isWeeklyLiteralCron`), where a sweep schedule must
 * select at least one kind and may fire as often as hourly.
 *
 * `kind` lives on the BASELINE only. An org-level override inherits it and
 * can never change it — an override that could flip a sweep baseline into a
 * narrative one for a single org would silently produce a run profile the
 * partner never configured.
 *
 * AI patch agent (W01) added `patch`: one `patch`-profile run per org that
 * returns a patch plan (`types/aiPatchPlan.ts`). Like `narrative`/`design` it
 * sweeps nothing (zero-cardinality `sweepKinds`), and it fires at most once
 * a day (see `isDailyOrRarerLiteralCron`).
 */
export const AI_AGENT_SCHEDULE_KINDS = ['sweep', 'narrative', 'design', 'patch'] as const;
export type AiAgentScheduleKind = (typeof AI_AGENT_SCHEDULE_KINDS)[number];

/** Severity a sweep evaluator assigns to one `SweepFinding`. */
export const AI_SWEEP_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type AiSweepSeverity = (typeof AI_SWEEP_SEVERITIES)[number];

/**
 * The one mutation a sweep finding may propose. Closed union, mirroring
 * `AlertVerdictSuggestedAction` in `aiAgents.ts`: a sweep-profile run only
 * ever proposes restarting a stopped service (`service_down` findings) or
 * remediating a vulnerability (`unpatched_critical` findings) — never an
 * arbitrary tool call.
 */
export type SweepProposedAction =
  | { tool: 'manage_services'; action: 'restart'; deviceId: string; serviceName: string }
  | { tool: 'remediate_vulnerability'; deviceId: string; deviceVulnerabilityIds: string[] };

/** One finding a `sweep`-profile run's evaluators produced. */
export interface SweepFinding {
  kind: AiSweepKind;
  severity: AiSweepSeverity;
  /** `null` for a fleet-wide finding not tied to one device. */
  deviceId?: string | null;
  title: string;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
  proposedAction?: SweepProposedAction;
}

/** Produced by the sweep-profile outcome tool and stored on the run. */
export interface SweepFindingsOutcome {
  summary: string;
  findings: SweepFinding[];
}

/**
 * Bookkeeping the fixed-tick sweeper writes back onto the triggering
 * schedule row after fanning an occurrence out across every org it applies
 * to. `occurrenceKey` is the sweeper's own idempotency key for this cron
 * tick (see the P2-2 plan's fixed-tick sweeper design) — stored so a
 * restarted sweeper can tell "already fanned this tick out" from "this tick
 * is new" without re-deriving it from `lastEnqueuedAt` alone.
 */
export interface AiAgentScheduleRunSummary {
  occurrenceKey: string;
  orgsTotal: number;
  runsAdmitted: number;
  runsSkipped: number;
  /** Keyed by skip reason (e.g. `circuit_open`, `budget_exceeded`, and
   *  `org_cap` — the orgs beyond `MAX_ORGS_PER_OCCURRENCE` that this
   *  occurrence did not reach). Aggregate counters only: never an org id. */
  skipReasons: Record<string, number>;
  enqueuedAt: string;
}

/**
 * The wire shape of one `ai_agent_schedules` row. A schedule is either a
 * partner-wide baseline (`ownerScope: 'partner'`, `orgId: null`) or an
 * org-level override of one (`ownerScope: 'organization'`,
 * `baselineScheduleId` pointing at the baseline it overrides) — never both,
 * never neither. See `createAiAgentScheduleSchema`'s discriminated shape.
 */
export interface AiAgentScheduleDto {
  id: string;
  ownerScope: 'partner' | 'organization';
  orgId: string | null;
  partnerId: string | null;
  agentId: string;
  baselineScheduleId: string | null;
  /** `sweep` for every schedule created before P2-3 — see
   *  `AI_AGENT_SCHEDULE_KINDS`. An org override always reports its
   *  baseline's kind, never one of its own. */
  kind: AiAgentScheduleKind;
  cron: string;
  timezone: string;
  sweepKinds: AiSweepKind[];
  enabled: boolean;
  /**
   * #4442 W04 — unattended ("act mode") sweep execution. THREE-VALUED and
   * deliberately raw so a UI can tell "inherit" from "explicitly off":
   *   on a partner BASELINE: `true` = armed, `false`/`null` = not armed;
   *   on an org OVERRIDE:    `false` = explicitly disarmed, `true`/`null` = inherit.
   * The effective value is `AiAgentEffectiveScheduleDto.effective.actMode`.
   */
  actMode: boolean | null;
  lastEnqueuedAt: string | null;
  lastOccurrenceKey: string | null;
  lastRunSummary: AiAgentScheduleRunSummary | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A partner baseline schedule merged with its org-level override (if any),
 * for surfaces that need to show both "what the partner set" and "what
 * actually applies to this org" — same `effective`/`override` split shape
 * used for `AiAgentPolicy`'s partner/org merge elsewhere in this package
 * (see `AiAgentPolicyProvenance`).
 */
export interface AiAgentEffectiveScheduleDto extends AiAgentScheduleDto {
  effective: { enabled: boolean; sweepKinds: AiSweepKind[]; actMode: boolean };
  override: { id: string; enabled: boolean; sweepKinds: AiSweepKind[]; actMode: boolean | null } | null;
}
