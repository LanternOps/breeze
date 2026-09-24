import { describe, expect, it, vi } from 'vitest';
import type { BreakingChangesManifest } from './breakingChangesManifest';
import type { DeploymentState } from './upgradePreflight';
import { buildDeprecationsView } from './deprecationsReport';
import { readDeploymentStateWith, type PreflightQuery } from './upgradePreflightRunner';

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
      id: 'deprecated-now',
      title: 'Old field deprecated',
      kind: 'api-response-field',
      surfaces: [{ endpoint: 'GET /api/v1/things', fields: ['old'] }],
      replacement: 'Read new instead.',
      deprecatedIn: '0.116.0',
      deprecationBehaviour: 'Still returned.',
      earliestRemovalDate: '2026-12-01',
      removedIn: null,
      removalBehaviour: 'Will be omitted.',
      references: [],
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

const seen = (...versions: string[]): DeploymentState['history'] => ({
  status: 'ok',
  versions: versions.map((version, i) => ({ version, firstSeenAt: new Date(Date.UTC(2026, 0, i + 1)) })),
});

function state(overrides: Partial<DeploymentState>): DeploymentState {
  return {
    currentVersion: '0.116.0',
    history: seen('0.115.0', '0.116.0'),
    ledger: { status: 'ok', appliedCount: 500, pendingCount: 0 },
    ...overrides,
  };
}

const statusOf = (view: ReturnType<typeof buildDeprecationsView>) =>
  Object.fromEntries(view.entries.map((e) => [e.id, `${e.status}:${e.milestone ?? '-'}`]));

describe('buildDeprecationsView', () => {
  it('marks retirements for a deployment that already booted this image: in effect and upcoming', () => {
    const view = buildDeprecationsView(MANIFEST, state({}), null);
    expect(view.historyKnown).toBe(true);
    expect(view.currentVersion).toBe('0.116.0');
    expect(view.lastRecordedVersion).toBe('0.116.0');
    expect(statusOf(view)).toEqual({
      pricing: 'in_effect:removal',
      'deprecated-now': 'upcoming:-',
      future: 'upcoming:-',
    });
  });

  it('keeps the full entry (replacement, surfaces, versions, removal date) for the table', () => {
    const view = buildDeprecationsView(MANIFEST, state({}), null);
    const pricing = view.entries.find((e) => e.id === 'pricing')!;
    expect(pricing.replacement).toBe('Use billing profiles.');
    expect(pricing.surfaces).toEqual([{ endpoint: 'PATCH /api/v1/things/:id', fields: ['rate'] }]);
    expect(pricing.deprecatedIn).toBe('0.115.0');
    expect(pricing.removedIn).toBe('0.116.0');
    expect(pricing.earliestRemovalDate).toBe('2026-09-22');
  });

  it('reports definite crossings when the recorded history is behind this image', () => {
    const view = buildDeprecationsView(MANIFEST, state({ history: seen('0.114.0') }), null);
    expect(statusOf(view)).toEqual({
      pricing: 'crossed:removal',
      'deprecated-now': 'crossed:deprecation',
      future: 'upcoming:-',
    });
  });

  it('never reports "no issues" when history is missing: every retirement in effect is possibly crossed', () => {
    const view = buildDeprecationsView(
      MANIFEST,
      state({ history: { status: 'missing', reason: 'could not read breeze_version_history: boom' } }),
      null,
    );
    expect(view.historyKnown).toBe(false);
    expect(view.historyNote).toMatch(/boom/);
    expect(view.history).toEqual({ status: 'missing', reason: 'could not read breeze_version_history: boom' });
    expect(statusOf(view)).toEqual({
      pricing: 'possibly_crossed:removal',
      'deprecated-now': 'possibly_crossed:deprecation',
      future: 'upcoming:-',
    });
  });

  it('treats an empty history as unknown, not as clean', () => {
    const view = buildDeprecationsView(MANIFEST, state({ history: seen() }), null);
    expect(view.historyKnown).toBe(false);
    expect(view.entries.find((e) => e.id === 'pricing')!.status).toBe('possibly_crossed');
  });

  it('lists every entry as possibly crossed when the image has no release version', () => {
    const view = buildDeprecationsView(MANIFEST, state({ currentVersion: '0.2.0' }), null);
    expect(view.currentVersion).toBeNull();
    expect(view.entries.every((e) => e.status === 'possibly_crossed')).toBe(true);
  });

  it('returns the recorded history newest first with ISO timestamps', () => {
    const view = buildDeprecationsView(MANIFEST, state({}), null);
    expect(view.history).toEqual({
      status: 'ok',
      versions: [
        { version: '0.116.0', firstSeenAt: '2026-01-02T00:00:00.000Z' },
        { version: '0.115.0', firstSeenAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
  });

  it('passes the ledger counts and a manifest error through', () => {
    const view = buildDeprecationsView(MANIFEST, state({}), 'breaking-changes.json failed validation: x');
    expect(view.ledger).toEqual({ status: 'ok', appliedCount: 500, pendingCount: 0 });
    expect(view.manifestError).toMatch(/failed validation/);
  });
});

describe('readDeploymentStateWith (query-injected reader)', () => {
  it('reads history and the ledger with SELECT statements only', async () => {
    const statements: string[] = [];
    const query: PreflightQuery = vi.fn(async (text: string) => {
      statements.push(text);
      if (/to_regclass/.test(text)) return [{ present: true }] as never;
      if (/breeze_version_history/.test(text)) {
        return [{ version: '0.116.0', first_seen_at: new Date('2026-09-20T00:00:00Z') }] as never;
      }
      return [] as never;
    });
    const result = await readDeploymentStateWith(query, '0.116.0');
    expect(result.history).toEqual({
      status: 'ok',
      versions: [{ version: '0.116.0', firstSeenAt: new Date('2026-09-20T00:00:00Z') }],
    });
    expect(result.ledger.status).toBe('ok');
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s.trim()).toMatch(/^SELECT\b/i);
  });

  it('returns Dates when the driver hands back timestamptz as text (Drizzle postgres-js)', async () => {
    const query: PreflightQuery = vi.fn(async (text: string) => {
      if (/to_regclass/.test(text)) return [{ present: true }] as never;
      if (/breeze_version_history/.test(text)) {
        return [
          { version: '0.115.0', first_seen_at: '2026-09-18 10:00:00.123456+00' },
          { version: '0.116.0', first_seen_at: '2026-09-20 05:30:00+05:30' },
        ] as never;
      }
      return [] as never;
    });
    const state = await readDeploymentStateWith(query, '0.116.0');
    expect(state.history).toEqual({
      status: 'ok',
      versions: [
        { version: '0.115.0', firstSeenAt: new Date('2026-09-18T10:00:00.123Z') },
        { version: '0.116.0', firstSeenAt: new Date('2026-09-20T00:00:00Z') },
      ],
    });
    const view = buildDeprecationsView(MANIFEST, state, null);
    expect(view.history).toEqual({
      status: 'ok',
      versions: [
        { version: '0.116.0', firstSeenAt: '2026-09-20T00:00:00.000Z' },
        { version: '0.115.0', firstSeenAt: '2026-09-18T10:00:00.123Z' },
      ],
    });
  });

  it('reports an unparseable first_seen_at as missing history instead of throwing', async () => {
    const query: PreflightQuery = vi.fn(async (text: string) => {
      if (/to_regclass/.test(text)) return [{ present: true }] as never;
      if (/breeze_version_history/.test(text)) return [{ version: '0.116.0', first_seen_at: 'not a time' }] as never;
      return [] as never;
    });
    const state = await readDeploymentStateWith(query, '0.116.0');
    expect(state.history.status).toBe('missing');
    expect(state.history.status === 'missing' && state.history.reason).toMatch(/first_seen_at/);
  });

  it('turns a failing history read into a "missing" state instead of throwing', async () => {
    const query: PreflightQuery = vi.fn(async (text: string) => {
      if (/to_regclass/.test(text)) return [{ present: true }] as never;
      throw new Error('permission denied for table breeze_version_history');
    });
    const result = await readDeploymentStateWith(query, '0.116.0');
    expect(result.history.status).toBe('missing');
    expect(result.history.status === 'missing' && result.history.reason).toMatch(/permission denied/);
    expect(result.ledger.status).toBe('missing');
  });

  it("surfaces the database's own message, not Drizzle's \"Failed query\" wrapper", async () => {
    const wrapped = Object.assign(new Error('Failed query: SELECT version, first_seen_at FROM breeze_version_history'), {
      cause: new Error('permission denied for table breeze_version_history'),
    });
    const query: PreflightQuery = vi.fn(async (text: string) => {
      if (/to_regclass/.test(text)) return [{ present: true }] as never;
      throw wrapped;
    });
    const result = await readDeploymentStateWith(query, '0.116.0');
    expect(result.history.status === 'missing' && result.history.reason).toBe(
      'could not read breeze_version_history: permission denied for table breeze_version_history',
    );
  });

  it('reports a missing history table as missing history', async () => {
    const query: PreflightQuery = vi.fn(async () => [{ present: false }] as never);
    const result = await readDeploymentStateWith(query, '0.116.0');
    expect(result.history.status).toBe('missing');
    expect(result.history.status === 'missing' && result.history.reason).toMatch(/does not exist/);
  });
});
