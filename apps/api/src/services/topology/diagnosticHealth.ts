import type {
  TopologyDiagnosticPlan,
  TopologyDiagnosticStep,
  TopologyHealthSummary,
} from '@breeze/shared';

/**
 * Deterministic health assessment for one accepted diagnostic plan.
 *
 * The rules come from the operations spec: a fresh successful required check is
 * healthy for its exact scope, mixed outcomes are degraded, fresh failed
 * required probes are a failed check, and missing, stale or unsupported required
 * evidence is unknown. Nothing here talks to the database or the clock unless a
 * caller declines to supply one, so the same inputs always assess identically.
 *
 * Deliberate non-inferences, each pinned by a test:
 * - an unanswered ICMP probe is `icmp_no_response`, never a claim the router is down;
 * - a step result that is not part of the accepted plan contributes nothing;
 * - a late (historical) or stale result is not evidence, only an attempt.
 */

export type DiagnosticMethod = TopologyDiagnosticPlan['steps'][number]['method'];

/**
 * A step result as the run store holds it. `historicalOnly` marks a late result
 * that arrived after its run reached a terminal state; it is retained as
 * evidence of what happened but may never drive current health.
 */
export type TopologyAssessmentStep = TopologyDiagnosticStep & { historicalOnly?: boolean };

export type TopologyDiagnosticRunCoverage = 'complete' | 'partial' | 'none';

export type TopologyDiagnosticRunAssessment = {
  summary: TopologyHealthSummary;
  coverage: TopologyDiagnosticRunCoverage;
};

export type AssessmentOptions = { now?: Date };

/** An isolated on-demand result stays current for five minutes (operations §5). */
export const DIAGNOSTIC_FRESHNESS_WINDOW_MS = 5 * 60_000;

/** Methods that actually put a packet on the wire, as opposed to reading local state. */
const PROBE_METHODS = new Set<DiagnosticMethod>(['icmp', 'dns', 'tcp', 'tls', 'http']);

/** States that carry a measurement. Everything else is an absence of evidence. */
const MEASURED_STATES = new Set<TopologyDiagnosticStep['state']>(['succeeded', 'failed_check', 'timeout']);

/** States that prove the agent reached the step, whether or not it measured anything. */
const ATTEMPTED_STATES = new Set<TopologyDiagnosticStep['state']>([
  'succeeded', 'failed_check', 'timeout', 'unsupported', 'execution_error',
]);

type Outcome = {
  stepId: string;
  method: DiagnosticMethod;
  required: boolean;
  succeeded: boolean;
};

function stepTimestamp(step: TopologyAssessmentStep): number | null {
  const stamp = step.receivedAt ?? step.finishedAt;
  if (!stamp) return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFresh(step: TopologyAssessmentStep, now: number): boolean {
  const stamp = stepTimestamp(step);
  return stamp !== null && now - stamp <= DIAGNOSTIC_FRESHNESS_WINDOW_MS && stamp - now <= DIAGNOSTIC_FRESHNESS_WINDOW_MS;
}

function failureReason(method: DiagnosticMethod, state: TopologyDiagnosticStep['state']): string {
  if (state === 'timeout') return method === 'icmp' ? 'icmp_no_response' : `${method}_timeout`;
  return `${method}_check_failed`;
}

function push(reasons: string[], code: string): void {
  if (!reasons.includes(code)) reasons.push(code);
}

/**
 * Assess one plan against the step results currently held for it.
 *
 * `evidenceRefs` lists the plan step IDs whose fresh measurements produced this
 * status, in plan order, so a reader can open exactly the evidence used.
 */
export function assessTopologyDiagnostic(
  plan: TopologyDiagnosticPlan,
  steps: TopologyAssessmentStep[],
  options: AssessmentOptions = {},
): TopologyHealthSummary {
  const now = (options.now ?? new Date()).getTime();
  const planned = plan.steps ?? [];

  // Results are indexed by plan step; an unrecognized step ID never participates.
  const results = new Map<string, TopologyAssessmentStep>();
  for (const step of steps) {
    if (planned.some((entry) => entry.id === step.id)) results.set(step.id, step);
  }

  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  const outcomes: Outcome[] = [];
  const missingRequired: string[] = [];
  let unsupportedRequired = 0;
  let staleRequired = false;
  let executionErrorRequired = false;

  for (const entry of planned) {
    const result = results.get(entry.id);
    const usable = result
      && !result.historicalOnly
      && isFresh(result, now)
      && MEASURED_STATES.has(result.state);

    if (usable && result) {
      evidenceRefs.push(entry.id);
      const succeeded = result.state === 'succeeded';
      outcomes.push({ stepId: entry.id, method: entry.method, required: entry.required, succeeded });
      if (succeeded) push(reasons, `${entry.method}_succeeded`);
      else push(reasons, failureReason(entry.method, result.state));
      continue;
    }

    if (!entry.required) continue;
    missingRequired.push(entry.id);

    if (result?.state === 'unsupported') {
      unsupportedRequired += 1;
      push(reasons, `${entry.method}_unsupported`);
    } else if (result?.state === 'execution_error') {
      executionErrorRequired = true;
      push(reasons, 'execution_error');
    } else if (result && (result.historicalOnly || MEASURED_STATES.has(result.state))) {
      // A measurement exists but is too old, or arrived after the run ended.
      staleRequired = true;
    }
  }

  const everyStepMeasured = planned.length > 0 && evidenceRefs.length === planned.length;
  const coverageForEvidence = everyStepMeasured ? 'monitored' : evidenceRefs.length ? 'partial' : 'unavailable';

  if (missingRequired.length) {
    push(reasons, 'missing_required_evidence');
    if (staleRequired) push(reasons, 'stale_required_evidence');
    const unsupportedOnly = unsupportedRequired === missingRequired.length && !executionErrorRequired;
    const coverage = unsupportedOnly
      ? 'unsupported'
      : evidenceRefs.length ? 'partial' : 'unavailable';
    return { status: 'unknown', coverage, reasons, evidenceRefs };
  }

  if (!planned.length || !outcomes.length) {
    push(reasons, 'missing_required_evidence');
    return { status: 'unknown', coverage: 'unavailable', reasons, evidenceRefs };
  }

  if (coverageForEvidence === 'partial') push(reasons, 'partial_coverage');

  const failures = outcomes.filter((outcome) => !outcome.succeeded);
  if (!failures.length) {
    return { status: 'healthy', coverage: coverageForEvidence, reasons, evidenceRefs };
  }

  // "All outbound checks failed from this collector" is a failed check. A single
  // failing protocol alongside a working one is degradation, not a dead path.
  const requiredProbes = outcomes.filter((outcome) => outcome.required && PROBE_METHODS.has(outcome.method));
  const everyRequiredProbeFailed = requiredProbes.length > 0
    && requiredProbes.every((outcome) => !outcome.succeeded);
  const status = everyRequiredProbeFailed && outcomes.every((outcome) => !outcome.succeeded)
    ? 'failed_check'
    : 'degraded';

  return { status, coverage: coverageForEvidence, reasons, evidenceRefs };
}

/**
 * The seam Task 18 result publication calls: it returns both the health summary
 * to persist as the run's `assessment`/`reasons` and the run's own attempted
 * coverage, which is about how much of the fixed plan executed rather than about
 * how much of the subject is monitored.
 */
export function assessTopologyDiagnosticRun(
  plan: TopologyDiagnosticPlan,
  steps: TopologyAssessmentStep[],
  options: AssessmentOptions = {},
): TopologyDiagnosticRunAssessment {
  const planned = plan.steps ?? [];
  const attempted = new Set<string>();
  for (const step of steps) {
    if (planned.some((entry) => entry.id === step.id) && ATTEMPTED_STATES.has(step.state)) {
      attempted.add(step.id);
    }
  }

  const coverage: TopologyDiagnosticRunCoverage = !attempted.size
    ? 'none'
    : attempted.size === planned.length ? 'complete' : 'partial';

  return { summary: assessTopologyDiagnostic(plan, steps, options), coverage };
}
