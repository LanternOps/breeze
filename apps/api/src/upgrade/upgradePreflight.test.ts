import { describe, expect, it } from 'vitest';
import type { BreakingChangesManifest } from './breakingChangesManifest';
import {
  buildPreflightReport,
  formatPreflightReport,
  normalizeReleaseVersion,
  preflightExitCode,
  type DeploymentState,
} from './upgradePreflight';

const MANIFEST: BreakingChangesManifest = {
  schemaVersion: 1,
  entries: [
    {
      id: 'pricing',
      title: 'Pricing fields retired',
      kind: 'api-request-field',
      surfaces: [{ endpoint: 'PATCH /api/v1/things/:id', fields: ['rate'] }],
      replacement: 'Use billing profiles.',
      deprecatedIn: '0.115.0',
      deprecationBehaviour: 'Accepted and ignored.',
      earliestRemovalDate: '2026-09-22',
      removedIn: '0.116.0',
      removalBehaviour: 'Rejected with HTTP 400.',
      references: ['#1'],
    },
    {
      id: 'future',
      title: 'Legacy endpoint deprecated',
      kind: 'api-endpoint',
      surfaces: [{ endpoint: 'GET /api/v1/legacy', fields: [] }],
      replacement: 'Use GET /api/v1/modern.',
      deprecatedIn: '0.120.0',
      deprecationBehaviour: 'Responds with a Deprecation header.',
      earliestRemovalDate: '2027-01-01',
      removedIn: null,
      removalBehaviour: 'Will return HTTP 410.',
      references: [],
    },
  ],
};

function state(overrides: Partial<DeploymentState>): DeploymentState {
  return {
    currentVersion: '0.116.0',
    history: { status: 'ok', versions: [] },
    ledger: { status: 'ok', appliedCount: 500, pendingCount: 0 },
    ...overrides,
  };
}

const seen = (...versions: string[]) => ({
  status: 'ok' as const,
  versions: versions.map((version, i) => ({ version, firstSeenAt: new Date(2026, 0, i + 1) })),
});

const ids = (items: Array<{ entry: { id: string } }>) => items.map((i) => i.entry.id);

describe('normalizeReleaseVersion', () => {
  it('accepts plain and v-prefixed versions and reduces a prerelease to its release core', () => {
    expect(normalizeReleaseVersion('0.116.0')).toBe('0.116.0');
    expect(normalizeReleaseVersion('v0.116.0')).toBe('0.116.0');
    // An RC of 0.116.0 already carries 0.116.0's removals.
    expect(normalizeReleaseVersion('0.116.0-rc.1')).toBe('0.116.0');
  });

  it('returns null for anything that is not a release version', () => {
    expect(normalizeReleaseVersion(undefined)).toBeNull();
    expect(normalizeReleaseVersion('')).toBeNull();
    expect(normalizeReleaseVersion('release-build-check')).toBeNull();
    expect(normalizeReleaseVersion('workspace-local')).toBeNull();
    // The Dockerfile ARG default / src/version.ts fallback, not a release.
    expect(normalizeReleaseVersion('0.2.0')).toBeNull();
  });
});

describe('buildPreflightReport', () => {
  it('reports a removal crossed between the last recorded version and this image', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.114.0', '0.115.0') }));
    expect(report.historyKnown).toBe(true);
    expect(report.lastRecordedVersion).toBe('0.115.0');
    expect(report.crossing).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: 'pricing' }), milestone: 'removal', certainty: 'definite' }),
    ]);
  });

  it('reports a deprecation being entered and lists its removal as upcoming', () => {
    const report = buildPreflightReport(MANIFEST, state({ currentVersion: '0.115.0', history: seen('0.114.0') }));
    expect(report.crossing).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: 'pricing' }), milestone: 'deprecation', certainty: 'definite' }),
    ]);
    expect(ids(report.upcoming)).toEqual(['pricing', 'future']);
  });

  it('reports a jump across both milestones as the removal', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.110.0') }));
    expect(report.crossing.map((c) => [c.entry.id, c.milestone])).toEqual([['pricing', 'removal']]);
  });

  it('crosses nothing when the deployment already ran this version (a restart)', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.115.0', '0.116.0') }));
    expect(report.crossing).toEqual([]);
    expect(ids(report.inEffect)).toEqual(['pricing']);
  });

  it('crosses nothing on a downgrade below a version the deployment already ran', () => {
    const report = buildPreflightReport(MANIFEST, state({ currentVersion: '0.115.0', history: seen('0.116.0') }));
    expect(report.crossing).toEqual([]);
  });

  it('treats a release candidate as the release it precedes', () => {
    const report = buildPreflightReport(MANIFEST, state({ currentVersion: '0.116.0-rc.2', history: seen('0.115.0') }));
    expect(report.crossing.map((c) => c.milestone)).toEqual(['removal']);
  });

  it('ignores non-release rows when finding the last recorded version', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.115.0', 'release-build-check') }));
    expect(report.lastRecordedVersion).toBe('0.115.0');
    expect(report.historyKnown).toBe(true);
  });

  describe('missing history gives a broader report, never "no issues"', () => {
    it('lists every retirement in effect as possibly crossing when the history table is missing', () => {
      const report = buildPreflightReport(
        MANIFEST,
        state({ history: { status: 'missing', reason: 'breeze_version_history does not exist' } }),
      );
      expect(report.historyKnown).toBe(false);
      expect(report.crossing).toEqual([
        expect.objectContaining({ entry: expect.objectContaining({ id: 'pricing' }), milestone: 'removal', certainty: 'possible' }),
      ]);
      expect(preflightExitCode(report, { strict: true })).toBe(1);
    });

    it('treats an empty history the same way', () => {
      const report = buildPreflightReport(MANIFEST, state({ history: seen() }));
      expect(report.historyKnown).toBe(false);
      expect(report.crossing.map((c) => c.certainty)).toEqual(['possible']);
    });

    it('treats a history of only non-release versions the same way', () => {
      const report = buildPreflightReport(MANIFEST, state({ history: seen('workspace-local') }));
      expect(report.historyKnown).toBe(false);
      expect(report.crossing.map((c) => c.certainty)).toEqual(['possible']);
    });

    it('lists every entry when this image does not know its own version', () => {
      const report = buildPreflightReport(MANIFEST, state({ currentVersion: 'release-build-check', history: seen('0.116.0') }));
      expect(report.currentVersion).toBeNull();
      expect(report.crossing.map((c) => [c.entry.id, c.certainty])).toEqual([
        ['pricing', 'possible'],
        ['future', 'possible'],
      ]);
    });

    it('never prints a clean bill of health without history', () => {
      const report = buildPreflightReport(MANIFEST, state({ history: { status: 'missing', reason: 'x' } }));
      const text = formatPreflightReport(report).join('\n');
      expect(text).toMatch(/no version history/i);
      expect(text).not.toMatch(/no retirements/i);
    });
  });
});

describe('preflightExitCode', () => {
  it('is always 0 outside strict mode', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.115.0') }));
    expect(report.crossing.length).toBeGreaterThan(0);
    expect(preflightExitCode(report, { strict: false })).toBe(0);
  });

  it('is 1 in strict mode when a removal is crossed', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.115.0') }));
    expect(preflightExitCode(report, { strict: true })).toBe(1);
  });

  it('is 0 in strict mode when only a deprecation is entered', () => {
    const report = buildPreflightReport(MANIFEST, state({ currentVersion: '0.115.0', history: seen('0.114.0') }));
    expect(preflightExitCode(report, { strict: true })).toBe(0);
  });

  it('is 0 in strict mode when nothing is crossed', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.116.0') }));
    expect(preflightExitCode(report, { strict: true })).toBe(0);
  });
});

describe('formatPreflightReport', () => {
  it('names the fields, the endpoint and the replacement for a crossed removal', () => {
    const report = buildPreflightReport(MANIFEST, state({ history: seen('0.115.0') }));
    const text = formatPreflightReport(report).join('\n');
    expect(text).toContain('0.115.0 -> 0.116.0');
    expect(text).toContain('PATCH /api/v1/things/:id');
    expect(text).toContain('rate');
    expect(text).toContain('Use billing profiles.');
    expect(text).toContain('Rejected with HTTP 400.');
  });

  it('never claims a clean upgrade when the manifest could not be read', () => {
    const report = buildPreflightReport({ schemaVersion: 1, entries: [] }, state({ history: seen('0.116.0') }), {
      manifestError: 'breaking-changes.json failed validation: entries.0.id: must be kebab-case',
    });
    const text = formatPreflightReport(report).join('\n');
    expect(text).toContain('failed validation');
    expect(text).not.toMatch(/crosses no retirement/i);
    expect(preflightExitCode(report, { strict: true })).toBe(1);
    expect(preflightExitCode(report, { strict: false })).toBe(0);
  });

  it('reports pending migrations and says when nothing is crossed', () => {
    const report = buildPreflightReport(
      MANIFEST,
      state({ history: seen('0.116.0'), ledger: { status: 'ok', appliedCount: 10, pendingCount: 3 } }),
    );
    const text = formatPreflightReport(report).join('\n');
    expect(text).toMatch(/3 pending migration/);
    expect(text).toMatch(/crosses no retirement/i);
  });
});
