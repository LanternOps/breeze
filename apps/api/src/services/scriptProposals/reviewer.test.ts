// apps/api/src/services/scriptProposals/reviewer.test.ts
//
// Pure-function coverage for the reviewer: `applyReviewFloors` (spec §4.4
// floors, raise-only) and `buildReviewerPrompt` (transcript-free, delimited).
// `runScriptReview` (DB/model/budget) is covered in runScriptReview.test.ts.
import { describe, expect, it } from 'vitest';
import type { ScriptReviewVerdict } from '@breeze/shared';
import { applyReviewFloors } from './reviewer';

function verdict(overrides: Partial<ScriptReviewVerdict> = {}): ScriptReviewVerdict {
  return {
    summary: 'test verdict',
    goalMatch: 'yes',
    riskTier: 'low',
    blastRadius: [],
    reversible: true,
    verificationAdequate: true,
    findings: [],
    recommendedAction: 'approve',
    ...overrides,
  };
}

describe('applyReviewFloors', () => {
  it('leaves a clean low-risk verdict untouched', () => {
    const result = applyReviewFloors(verdict(), { strictHits: [], touchClasses: [] });
    expect(result).toEqual(verdict());
  });

  it.each([
    ['strict hit present', { strictHits: ['obfuscated invoke'], touchClasses: [] }, 'medium'],
    ['credentials touch class', { strictHits: [], touchClasses: ['credentials'] }, 'high'],
    ['security_tooling touch class', { strictHits: [], touchClasses: ['security_tooling'] }, 'high'],
    ['boot touch class', { strictHits: [], touchClasses: ['boot'] }, 'high'],
    ['disk touch class', { strictHits: [], touchClasses: ['disk'] }, 'high'],
    ['shell_eval touch class', { strictHits: [], touchClasses: ['shell_eval'] }, 'high'],
    ['users_groups touch class', { strictHits: [], touchClasses: ['users_groups'] }, 'medium'],
    ['firewall touch class', { strictHits: [], touchClasses: ['firewall'] }, 'medium'],
    ['scheduled_tasks touch class', { strictHits: [], touchClasses: ['scheduled_tasks'] }, 'medium'],
    ['registry touch class', { strictHits: [], touchClasses: ['registry'] }, 'medium'],
  ] as const)('raises a model-said-low verdict to %s (%s)', (_label, scan, expected) => {
    const result = applyReviewFloors(verdict({ riskTier: 'low' }), scan as never);
    expect(result.riskTier).toBe(expected);
  });

  it('non-floor touch classes (services, printing, …) do not raise', () => {
    const result = applyReviewFloors(verdict({ riskTier: 'low' }), {
      strictHits: [],
      touchClasses: ['services', 'printing', 'processes'],
    });
    expect(result.riskTier).toBe('low');
  });

  it('a high-floor class beats a medium-floor class also present', () => {
    const result = applyReviewFloors(verdict({ riskTier: 'low' }), {
      strictHits: [],
      touchClasses: ['registry', 'disk'],
    });
    expect(result.riskTier).toBe('high');
  });

  it('NEVER lowers — a model-said-critical verdict stays critical even with no matches', () => {
    const result = applyReviewFloors(verdict({ riskTier: 'critical' }), { strictHits: [], touchClasses: [] });
    expect(result.riskTier).toBe('critical');
  });

  it('NEVER lowers — a model-said-high verdict with only a medium-floor class stays high', () => {
    const result = applyReviewFloors(verdict({ riskTier: 'high' }), {
      strictHits: [],
      touchClasses: ['registry'],
    });
    expect(result.riskTier).toBe('high');
  });

  it("floors come from the CLASSIFIER, never from the model's own blastRadius", () => {
    const result = applyReviewFloors(
      verdict({ riskTier: 'low', blastRadius: ['wipes the disk', 'credentials', 'boot'] }),
      { strictHits: [], touchClasses: [] },
    );
    expect(result.riskTier).toBe('low');
  });

  it('goalMatch=no forces recommendedAction to reject, even over an approve', () => {
    const result = applyReviewFloors(verdict({ goalMatch: 'no', recommendedAction: 'approve' }), {
      strictHits: [],
      touchClasses: [],
    });
    expect(result.recommendedAction).toBe('reject');
  });

  it('verificationAdequate=false downgrades an approve to changes', () => {
    const result = applyReviewFloors(verdict({ verificationAdequate: false, recommendedAction: 'approve' }), {
      strictHits: [],
      touchClasses: [],
    });
    expect(result.recommendedAction).toBe('changes');
  });

  it('verificationAdequate=false leaves an already-reject verdict at reject', () => {
    const result = applyReviewFloors(verdict({ verificationAdequate: false, recommendedAction: 'reject' }), {
      strictHits: [],
      touchClasses: [],
    });
    expect(result.recommendedAction).toBe('reject');
  });

  it('verificationAdequate=false leaves an already-changes verdict at changes', () => {
    const result = applyReviewFloors(verdict({ verificationAdequate: false, recommendedAction: 'changes' }), {
      strictHits: [],
      touchClasses: [],
    });
    expect(result.recommendedAction).toBe('changes');
  });

  it('preserves every other verdict field unchanged', () => {
    const input = verdict({ summary: 'keep me', blastRadius: ['a', 'b'], findings: [{ severity: 'info', text: 'x' }] });
    const result = applyReviewFloors(input, { strictHits: [], touchClasses: [] });
    expect(result.summary).toBe('keep me');
    expect(result.blastRadius).toEqual(['a', 'b']);
    expect(result.findings).toEqual([{ severity: 'info', text: 'x' }]);
    expect(result.reversible).toBe(true);
  });

  it('is pure — the input verdict is not mutated', () => {
    const input = verdict({ riskTier: 'low', goalMatch: 'no' });
    applyReviewFloors(input, { strictHits: ['x'], touchClasses: ['disk'] });
    expect(input.riskTier).toBe('low');
    expect(input.recommendedAction).toBe('approve');
  });
});
