import { describe, expect, it } from 'vitest';
import {
  RISK_TIERS, SCRIPT_PROPOSAL_STATUSES, proposeScriptInputSchema, riskTierRank,
  scriptReviewVerdictSchema, scriptVerificationClaimSchema,
} from './scriptProposals';

const base = {
  language: 'powershell' as const,
  content: 'Restart-Service -Name Spooler',
  goal: 'Print jobs are stuck on this workstation',
  expectedEffect: 'The print spooler service is restarted',
  verification: { kind: 'service_running' as const, name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
};

describe('scriptVerificationClaimSchema', () => {
  it('accepts each v1 claim kind', () => {
    for (const claim of [
      { kind: 'exit_code', equals: 0 },
      { kind: 'service_running', name: 'Spooler' },
      { kind: 'process_absent', name: 'stuckapp.exe' },
      { kind: 'file_exists', path: 'C:\\ProgramData\\Breeze\\ok.txt' },
      { kind: 'output_matches', regex: 'Running' },
    ]) {
      expect(scriptVerificationClaimSchema.safeParse(claim).success).toBe(true);
    }
  });

  it('rejects an unknown kind and a claim missing its discriminant payload', () => {
    expect(scriptVerificationClaimSchema.safeParse({ kind: 'vibes' }).success).toBe(false);
    expect(scriptVerificationClaimSchema.safeParse({ kind: 'service_running' }).success).toBe(false);
  });

  it('rejects an output_matches regex that does not compile', () => {
    expect(scriptVerificationClaimSchema.safeParse({ kind: 'output_matches', regex: '(' }).success).toBe(false);
  });
});

describe('proposeScriptInputSchema', () => {
  it('accepts a minimal proposal and defaults runAs and timeoutSeconds', () => {
    const parsed = proposeScriptInputSchema.parse(base);
    expect(parsed.runAs).toBe('system');
    expect(parsed.timeoutSeconds).toBe(300);
  });

  it('rejects content over 64 KiB', () => {
    expect(proposeScriptInputSchema.safeParse({ ...base, content: 'a'.repeat(65537) }).success).toBe(false);
  });

  it('rejects 0 and 11 devices, accepts 10', () => {
    const id = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;
    expect(proposeScriptInputSchema.safeParse({ ...base, deviceIds: [] }).success).toBe(false);
    expect(proposeScriptInputSchema.safeParse({
      ...base, deviceIds: Array.from({ length: 10 }, (_, i) => id(i)),
    }).success).toBe(true);
    expect(proposeScriptInputSchema.safeParse({
      ...base, deviceIds: [...Array.from({ length: 10 }, (_, i) => id(i)), id(0)],
    }).success).toBe(false);
  });

  it('rejects runAs elevated — a proposal is never elevated in v1', () => {
    expect(proposeScriptInputSchema.safeParse({ ...base, runAs: 'elevated' }).success).toBe(false);
  });

  it('rejects a timeout above 3600', () => {
    expect(proposeScriptInputSchema.safeParse({ ...base, timeoutSeconds: 3601 }).success).toBe(false);
  });
});

describe('risk tiers and statuses', () => {
  it('ranks low..critical as 0..3', () => {
    expect(RISK_TIERS.map(riskTierRank)).toEqual([0, 1, 2, 3]);
  });

  it('declares the thirteen proposal statuses', () => {
    expect(SCRIPT_PROPOSAL_STATUSES).toHaveLength(13);
    expect(SCRIPT_PROPOSAL_STATUSES).toContain('scan_rejected');
    expect(SCRIPT_PROPOSAL_STATUSES).toContain('promoted');
  });
});

describe('scriptReviewVerdictSchema', () => {
  const valid = {
    summary: 'Restarts the print spooler service.',
    goalMatch: 'yes' as const,
    riskTier: 'low' as const,
    blastRadius: ['print spooler restarts, jobs in queue are lost'],
    reversible: true,
    verificationAdequate: true,
    findings: [{ severity: 'info' as const, text: 'No destructive operations detected.' }],
    recommendedAction: 'approve' as const,
  };

  it('accepts a well-formed verdict', () => {
    expect(scriptReviewVerdictSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a finding with an optional lineRef', () => {
    const withLineRef = {
      ...valid,
      findings: [{ severity: 'warning' as const, text: 'Reads a registry key.', lineRef: 4 }],
    };
    expect(scriptReviewVerdictSchema.parse(withLineRef).findings[0]?.lineRef).toBe(4);
  });

  it('rejects a summary over 600 chars', () => {
    expect(() => scriptReviewVerdictSchema.parse({ ...valid, summary: 'x'.repeat(601) })).toThrow();
  });

  it('rejects an unknown goalMatch value', () => {
    expect(() => scriptReviewVerdictSchema.parse({ ...valid, goalMatch: 'sort of' })).toThrow();
  });

  it('rejects an unknown recommendedAction value', () => {
    expect(() => scriptReviewVerdictSchema.parse({ ...valid, recommendedAction: 'maybe' })).toThrow();
  });

  it('rejects an unknown finding severity', () => {
    expect(() =>
      scriptReviewVerdictSchema.parse({ ...valid, findings: [{ severity: 'urgent', text: 'x' }] })
    ).toThrow();
  });

  it('rejects a missing findings array', () => {
    const { findings: _findings, ...rest } = valid;
    expect(() => scriptReviewVerdictSchema.parse(rest)).toThrow();
  });

  it('defaults blastRadius to an empty array when omitted', () => {
    const { blastRadius: _blastRadius, ...rest } = valid;
    expect(scriptReviewVerdictSchema.parse(rest).blastRadius).toEqual([]);
  });
});
