import { describe, expect, it } from 'vitest';
import { summarizeBareMetalEvidence, type BareMetalEvidenceRow } from './bareMetalReadinessEvidence';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const min = (n: number) => n * 60_000;
const day = (n: number) => n * 86_400_000;

function row(over: Partial<BareMetalEvidenceRow>): BareMetalEvidenceRow {
  return {
    status: 'completed',
    identity: 'new',
    platform: 'linux',
    drExecutionId: null,
    executingDeviceId: null,
    restoringAt: new Date(NOW - day(2)),
    validatedAt: new Date(NOW - day(2) + min(12)),
    completedAt: new Date(NOW - day(2) + min(12)),
    createdAt: new Date(NOW - day(2) - min(5)),
    ...over,
  };
}

describe('summarizeBareMetalEvidence', () => {
  it('returns no evidence for no rows', () => {
    const s = summarizeBareMetalEvidence([], NOW);
    expect(s.hasEvidence).toBe(false);
    expect(s.measuredRtoMinutes).toBeNull();
    expect(s.riskFactors).toEqual([]);
  });

  it('measures RTO from restoring→validated of successful rebuilds (max of recent successes)', () => {
    const s = summarizeBareMetalEvidence([
      row({}),
      row({
        restoringAt: new Date(NOW - day(3)),
        validatedAt: new Date(NOW - day(3) + min(30)),
        completedAt: new Date(NOW - day(3) + min(30)),
      }),
    ], NOW);
    expect(s.measuredRtoMinutes).toBe(30);
    expect(s.successCount).toBe(2);
    expect(s.riskFactors).toEqual([]);
  });

  it('does not count refused rows as failures but flags failed ones', () => {
    const s = summarizeBareMetalEvidence([
      row({ status: 'refused', validatedAt: null, completedAt: null }),
      row({ status: 'failed', validatedAt: null, completedAt: null }),
    ], NOW);
    expect(s.failureCount).toBe(1);
    expect(s.riskFactors.map((r) => r.code)).toContain('bare_metal_recovery_failed');
    expect(s.measuredRtoMinutes).toBeNull();
  });

  it('flags a stale last successful rebuild (>90d)', () => {
    const old = row({
      createdAt: new Date(NOW - day(100)),
      restoringAt: new Date(NOW - day(100)),
      validatedAt: new Date(NOW - day(100) + min(10)),
      completedAt: new Date(NOW - day(100) + min(10)),
    });
    const s = summarizeBareMetalEvidence([old], NOW);
    expect(s.riskFactors.map((r) => r.code)).toContain('bare_metal_rehearsal_stale');
  });

  it('puts a latest failure first even when an older success exists', () => {
    // Newest row deliberately listed last: ordering must come from createdAt.
    const s = summarizeBareMetalEvidence([
      row({}),
      row({ status: 'failed', validatedAt: null, completedAt: null, createdAt: new Date(NOW - day(1)), restoringAt: new Date(NOW - day(1)) }),
    ], NOW);
    expect(s.latestFailed).toBe(true);
    expect(s.riskFactors[0]?.code).toBe('bare_metal_recovery_failed');
    expect(s.riskFactors[0]?.severity).toBe('high');
  });

  it('a failure followed by a later success is medium, not latestFailed', () => {
    const s = summarizeBareMetalEvidence([
      row({ status: 'failed', validatedAt: null, completedAt: null, createdAt: new Date(NOW - day(5)), restoringAt: new Date(NOW - day(5)) }),
      row({}),
    ], NOW);
    expect(s.latestFailed).toBe(false);
    expect(s.riskFactors[0]).toMatchObject({ code: 'bare_metal_recovery_failed', severity: 'medium' });
  });

  it('only refused rows is no evidence', () => {
    const s = summarizeBareMetalEvidence([row({ status: 'refused', validatedAt: null, completedAt: null })], NOW);
    expect(s.hasEvidence).toBe(false);
  });

  it('exactly 60 minutes is not above target', () => {
    const s = summarizeBareMetalEvidence([
      row({ validatedAt: new Date(NOW - day(2) + min(60)), completedAt: new Date(NOW - day(2) + min(60)) }),
    ], NOW);
    expect(s.measuredRtoMinutes).toBe(60);
    expect(s.riskFactors.map((r) => r.code)).not.toContain('bare_metal_rto_above_target');
  });

  it('classifies rebuild-host/DR rehearsals separately from boot-media production', () => {
    const s = summarizeBareMetalEvidence([
      row({ drExecutionId: 'x', executingDeviceId: 'h' }),
      row({ identity: 'original', status: 'checked_in', createdAt: new Date(NOW - day(3)) }),
    ], NOW);
    expect(s.rehearsalSuccessCount).toBe(1);
    expect(s.productionSuccessCount).toBe(1);
  });

  it('flags a measured RTO above 60 minutes', () => {
    const s = summarizeBareMetalEvidence([
      row({ validatedAt: new Date(NOW - day(2) + min(90)), completedAt: new Date(NOW - day(2) + min(90)) }),
    ], NOW);
    expect(s.measuredRtoMinutes).toBe(90);
    expect(s.riskFactors.map((r) => r.code)).toContain('bare_metal_rto_above_target');
  });

  it('ignores in-flight rows', () => {
    const s = summarizeBareMetalEvidence([row({ status: 'restoring', validatedAt: null, completedAt: null })], NOW);
    expect(s.hasEvidence).toBe(false);
  });
});
