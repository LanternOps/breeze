// packages/shared/src/trustCenter/evaluate.ts
import {
  TELEMETRY_CONTROL_IDS, type ControlEvidence, type PostureControlEvidence, type TelemetryControlId,
  type TrustControlAssessment, type TrustControlDefinition, type TrustControlStatus, type TrustEvaluationPolicy,
} from './types';

/** By reference to securityCompliancePostureConfigSchema defaults (spec §5.2, §18.5). */
export const DEFAULT_TRUST_EVALUATION_POLICY: TrustEvaluationPolicy = {
  coverageFloorPct: 80,
  thresholds: { met: 95, attention: 80 },
  evidenceMaxAgeDays: 30,
};

export function emptyControlEvidence(): PostureControlEvidence {
  const out = {} as PostureControlEvidence;
  for (const id of TELEMETRY_CONTROL_IDS) {
    out[id] = { eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null };
  }
  return out;
}

const pct = (num: number, denom: number): number => Math.round((num / denom) * 100);

function notAssessed(def: TrustControlDefinition, e: ControlEvidence, reason: TrustControlAssessment['reason']): TrustControlAssessment {
  return {
    id: def.id, category: def.category, source: 'telemetry', unit: def.unit,
    status: 'not_assessed', reason, percent: null,
    assessed: e.assessed, eligible: e.eligible, evidenceAsOf: e.newestEvidenceAt, frameworkRefs: def.frameworkRefs,
  };
}

function statusForHigherIsBetter(value: number, t: TrustEvaluationPolicy['thresholds']): TrustControlStatus {
  if (value >= t.met) return 'met';
  if (value >= t.attention) return 'attention';
  return 'not_met';
}

function evaluateOne(def: TrustControlDefinition, e: ControlEvidence, policy: TrustEvaluationPolicy, asOf: Date): TrustControlAssessment {
  if (e.eligible <= 0 || e.assessed <= 0) return notAssessed(def, e, 'no_data');

  if (e.newestEvidenceAt) {
    const ageMs = asOf.getTime() - new Date(e.newestEvidenceAt).getTime();
    // An unparseable timestamp is not evidence of freshness (spec §19 item 18).
    if (!Number.isFinite(ageMs)) return notAssessed(def, { ...e, newestEvidenceAt: null }, 'insufficient_telemetry');
    if (ageMs > policy.evidenceMaxAgeDays * 86_400_000) return notAssessed(def, e, 'insufficient_telemetry');
  }
  if (def.metric !== 'boolean' && pct(e.assessed, e.eligible) < policy.coverageFloorPct) {
    return notAssessed(def, e, 'insufficient_telemetry');
  }

  let percent: number | null;
  let status: TrustControlStatus;
  switch (def.metric) {
    case 'boolean':
      percent = null;
      status = e.passing > 0 ? 'met' : 'not_met';
      break;
    case 'coverage_pct':
      percent = pct(e.passing, e.assessed);
      status = statusForHigherIsBetter(percent, policy.thresholds);
      break;
    case 'exposure_pct': {
      percent = pct(e.assessed - e.passing, e.assessed);
      const good = 100 - percent;
      status = statusForHigherIsBetter(good, policy.thresholds);
      break;
    }
    case 'pass_rate':
      if (e.aggregatePct === null) return notAssessed(def, e, 'no_data');
      percent = Math.round(e.aggregatePct);
      status = statusForHigherIsBetter(percent, policy.thresholds);
      break;
  }
  if (def.gate && status === 'met' && e.gate !== true) status = 'attention';

  return {
    id: def.id, category: def.category, source: 'telemetry', unit: def.unit,
    status, reason: null, percent,
    assessed: e.assessed, eligible: e.eligible, evidenceAsOf: e.newestEvidenceAt, frameworkRefs: def.frameworkRefs,
  };
}

/** Pure. Output order = insurerRank ascending. */
export function evaluateTrustControls(
  catalog: readonly TrustControlDefinition[],
  evidence: PostureControlEvidence,
  policy: TrustEvaluationPolicy,
  asOf: Date,
): TrustControlAssessment[] {
  return [...catalog]
    .sort((a, b) => a.insurerRank - b.insurerRank)
    .map((def) => evaluateOne(def, evidence[def.id] ?? { eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null }, policy, asOf));
}

export type TrustPillRole = 'success' | 'warning' | 'danger' | 'neutral';
export function trustStatusPillRole(status: TrustControlStatus): TrustPillRole {
  switch (status) {
    case 'met': return 'success';
    case 'attention': return 'warning';
    case 'not_met': return 'danger';
    case 'not_assessed': return 'neutral';
  }
}
export function trustStatusLabel(status: TrustControlStatus): string {
  switch (status) {
    case 'met': return 'Met';
    case 'attention': return 'Needs attention';
    case 'not_met': return 'Not met';
    case 'not_assessed': return 'Not assessed';
  }
}
