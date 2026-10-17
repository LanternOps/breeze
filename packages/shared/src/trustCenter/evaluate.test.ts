import { describe, expect, it } from 'vitest';
import { TRUST_CONTROL_CATALOG } from './controlCatalog';
import { DEFAULT_TRUST_EVALUATION_POLICY, emptyControlEvidence, evaluateTrustControls, trustStatusPillRole } from './evaluate';
import type { ControlEvidence, PostureControlEvidence, TelemetryControlId } from './types';

const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const fresh = '2026-10-13T11:00:00.000Z';

function evidence(over: Partial<Record<TelemetryControlId, Partial<ControlEvidence>>> = {}): PostureControlEvidence {
  const base = emptyControlEvidence();
  for (const [id, patch] of Object.entries(over)) {
    base[id as TelemetryControlId] = { ...base[id as TelemetryControlId], ...patch };
  }
  return base;
}
const byId = (list: ReturnType<typeof evaluateTrustControls>, id: TelemetryControlId) => list.find((a) => a.id === id)!;

describe('evaluateTrustControls', () => {
  it('returns one assessment per catalog entry, in insurer order', () => {
    const out = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF);
    expect(out).toHaveLength(TRUST_CONTROL_CATALOG.length);
    expect(out[0]?.id).toBe('mfa_enforced_m365');
  });

  it('no data → not_assessed/no_data with null percent', () => {
    const a = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF), 'disk_encryption');
    expect(a).toMatchObject({ status: 'not_assessed', reason: 'no_data', percent: null, evidenceAsOf: null });
  });

  it('coverage: 79% assessed → insufficient_telemetry; 80% → evaluated', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const low = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ disk_encryption: { eligible: 100, assessed: 79, passing: 79, newestEvidenceAt: fresh } }), p, AS_OF), 'disk_encryption');
    expect(low).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, assessed: 79, eligible: 100 });
    const ok = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ disk_encryption: { eligible: 100, assessed: 80, passing: 76, newestEvidenceAt: fresh } }), p, AS_OF), 'disk_encryption');
    expect(ok).toMatchObject({ status: 'met', percent: 95 });
  });

  it('thresholds: 95 met, 94 attention, 79 not_met', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (passing: number) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ host_firewall: { eligible: 100, assessed: 100, passing, newestEvidenceAt: fresh } }), p, AS_OF), 'host_firewall');
    expect(run(95).status).toBe('met');
    expect(run(94).status).toBe('attention');
    expect(run(80).status).toBe('attention');
    expect(run(79).status).toBe('not_met');
  });

  it('exposure inverts: 4% flagged → met, 10% → attention, 30% → not_met; percent is the exposure', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (passing: number) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ least_privilege: { eligible: 100, assessed: 100, passing, newestEvidenceAt: fresh } }), p, AS_OF), 'least_privilege');
    expect(run(96)).toMatchObject({ status: 'met', percent: 4 });
    expect(run(90)).toMatchObject({ status: 'attention', percent: 10 });
    expect(run(70)).toMatchObject({ status: 'not_met', percent: 30 });
  });

  it('boolean: assessed 0 → no_data; passing 1 → met; passing 0 → not_met; percent null', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (e: Partial<ControlEvidence>) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ dns_filtering: e }), p, AS_OF), 'dns_filtering');
    expect(run({ eligible: 1, assessed: 0, passing: 0 })).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
    expect(run({ eligible: 1, assessed: 1, passing: 1, newestEvidenceAt: fresh })).toMatchObject({ status: 'met', percent: null });
    expect(run({ eligible: 1, assessed: 1, passing: 0, newestEvidenceAt: fresh })).toMatchObject({ status: 'not_met', percent: null });
  });

  it('pass_rate uses aggregatePct and still applies the coverage floor', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const ok = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ hardening_baseline: { eligible: 10, assessed: 9, passing: 0, aggregatePct: 88, newestEvidenceAt: fresh } }), p, AS_OF), 'hardening_baseline');
    expect(ok).toMatchObject({ status: 'attention', percent: 88 });
    const thin = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ hardening_baseline: { eligible: 10, assessed: 2, passing: 0, aggregatePct: 100, newestEvidenceAt: fresh } }), p, AS_OF), 'hardening_baseline');
    expect(thin).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry' });
  });

  it('MFA gate: 100% registered but an admin without MFA → attention, not met', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (gate: boolean) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ mfa_registered_m365: { eligible: 50, assessed: 50, passing: 50, gate, newestEvidenceAt: fresh } }), p, AS_OF), 'mfa_registered_m365');
    expect(run(true).status).toBe('met');
    expect(run(false).status).toBe('attention');
  });

  it('evidence older than the window → insufficient_telemetry even with full coverage', () => {
    const stale = '2026-09-01T00:00:00.000Z';
    const a = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ host_firewall: { eligible: 10, assessed: 10, passing: 10, newestEvidenceAt: stale } }), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF), 'host_firewall');
    expect(a).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry', evidenceAsOf: stale });
  });

  it('an unparseable newestEvidenceAt counts as stale → insufficient_telemetry', () => {
    const a = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ disk_encryption: { eligible: 10, assessed: 10, passing: 10, newestEvidenceAt: 'not-a-date' } }), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF), 'disk_encryption');
    // evidenceAsOf is nulled: the payload contract requires an ISO date or null.
    expect(a).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, evidenceAsOf: null });
  });

  it('never emits a percent for a not_assessed control', () => {
    const out = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF);
    expect(out.every((a) => a.status !== 'not_assessed' || a.percent === null)).toBe(true);
  });
});

describe('trustStatusPillRole', () => {
  it('maps every status', () => {
    expect(trustStatusPillRole('met')).toBe('success');
    expect(trustStatusPillRole('attention')).toBe('warning');
    expect(trustStatusPillRole('not_met')).toBe('danger');
    expect(trustStatusPillRole('not_assessed')).toBe('neutral');
  });
});

describe('hardening safeguards (W3e)', () => {
  const p = DEFAULT_TRUST_EVALUATION_POLICY;
  const hardening = (safeguards?: ControlEvidence['safeguards']) =>
    byId(
      evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ hardening_baseline: { eligible: 12, assessed: 12, passing: 12, aggregatePct: 99, newestEvidenceAt: fresh, safeguards } }), p, AS_OF),
      'hardening_baseline',
    );

  it('safeguards are evaluated as coverage_pct with the page thresholds and the coverage floor', () => {
    const a = hardening({
      '4.5': { eligible: 12, assessed: 12, passing: 12, newestEvidenceAt: fresh },
      '4.7': { eligible: 12, assessed: 12, passing: 11, newestEvidenceAt: fresh },   // 92% → attention
      '4.8': { eligible: 12, assessed: 12, passing: 8, newestEvidenceAt: fresh },    // 67% → not_met
      '3.6': { eligible: 12, assessed: 9, passing: 9, newestEvidenceAt: fresh },     // 75% assessed < floor
      '8.5': { eligible: 0, assessed: 0, passing: 0, newestEvidenceAt: null },
    });
    const by = Object.fromEntries((a.safeguards ?? []).map((s) => [s.ref, s]));
    expect(by['4.5']).toEqual({ framework: 'cis_v8', ref: '4.5', status: 'met', reason: null, percent: 100, assessed: 12, eligible: 12 });
    expect(by['4.7']).toMatchObject({ status: 'attention', percent: 92 });
    expect(by['4.8']).toMatchObject({ status: 'not_met', percent: 67 });
    expect(by['3.6']).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, assessed: 9, eligible: 12 });
    expect(by['8.5']).toMatchObject({ status: 'not_assessed', reason: 'no_data', percent: null });
  });

  it('a safeguard whose newest evidence is older than the window is not assessed', () => {
    const a = hardening({ '4.5': { eligible: 12, assessed: 12, passing: 12, newestEvidenceAt: '2026-08-01T00:00:00.000Z' } });
    expect(a.safeguards?.[0]).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry' });
  });

  it('eligible devices but nothing assessed → no_data', () => {
    const a = hardening({ '4.5': { eligible: 12, assessed: 0, passing: 0, newestEvidenceAt: null } });
    expect(a.safeguards?.[0]).toMatchObject({ status: 'not_assessed', reason: 'no_data', assessed: 0, eligible: 12 });
  });

  it('sorted by ref numerically ("4.5" before "10.5")', () => {
    const e = { eligible: 1, assessed: 1, passing: 1, newestEvidenceAt: fresh };
    const a = hardening({ '10.5': e, '4.5': e, '3.3': e, '4.10': e });
    expect(a.safeguards?.map((s) => s.ref)).toEqual(['3.3', '4.5', '4.10', '10.5']);
  });

  it('absent when evidence has no safeguards', () => {
    expect(hardening(undefined)).not.toHaveProperty('safeguards');
  });

  it('only hardening_baseline carries safeguards', () => {
    const out = evaluateTrustControls(
      TRUST_CONTROL_CATALOG,
      evidence({ host_firewall: { eligible: 1, assessed: 1, passing: 1, newestEvidenceAt: fresh, safeguards: { '4.5': { eligible: 1, assessed: 1, passing: 1, newestEvidenceAt: fresh } } } }),
      p, AS_OF,
    );
    expect(byId(out, 'host_firewall')).not.toHaveProperty('safeguards');
  });
});
