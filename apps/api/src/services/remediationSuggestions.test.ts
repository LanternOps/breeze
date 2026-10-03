import { describe, expect, it, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (which are themselves hoisted) can read them.
const h = vi.hoisted(() => {
  const TABLE = '__table__';
  const tbl = (name: string, extra: Record<string, string> = {}) => ({ [TABLE]: name, ...extra });
  return {
    TABLE,
    insertedRows: [] as Array<Record<string, unknown>>,
    // Per-table rows returned by candidate/context selects; reset in beforeEach.
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    tables: {
      alertCorrelationGroups: tbl('alertCorrelationGroups'),
      alerts: tbl('alerts'),
      devices: tbl('devices', { id: 'd', osType: 'd' }),
      metricAnomalies: tbl('metricAnomalies'),
      organizations: tbl('organizations', { id: 'o', partnerId: 'o' }),
      playbookDefinitions: tbl('playbookDefinitions', { id: 'p', name: 'p', description: 'p', category: 'p', isBuiltIn: 'p', isActive: 'p', orgId: 'p' }),
      remediationSuggestions: tbl('remediationSuggestions', { orgId: 'r', sourceType: 'r', sourceId: 'r' }),
      scripts: tbl('scripts', { id: 's', name: 's', description: 's', category: 's', runAs: 's', deletedAt: 's', isSystem: 's', orgId: 's', updatedAt: 's', osTypes: 's' }),
      scriptTemplates: tbl('scriptTemplates', { id: 't', name: 't', description: 't', category: 't', rating: 't', downloads: 't', language: 't' }),
    },
  };
});

const insertedRows = h.insertedRows;

vi.mock('../db', () => {
  // Chainable query builder; the resolved value depends on the `from` table.
  function makeSelectChain() {
    let table: string | undefined;
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain.from = (t: Record<string, string>) => { table = t?.[h.TABLE]; return chain; };
    chain.where = passthrough;
    chain.orderBy = passthrough;
    chain.limit = passthrough;
    chain.then = (resolve: (v: unknown) => unknown) => {
      // Source-context lookups resolve to a seeded anomaly; everything else empty.
      if (table && h.rows[table]) return resolve(h.rows[table]);
      if (table === 'metricAnomalies') {
        return resolve([{
          id: 'anomaly-1', orgId: 'org-1', deviceId: 'dev-1', linkedAlertId: null,
          linkedCorrelationGroupId: null, anomalyType: 'zzz_no_match', metricType: 'zzz',
          metricName: 'zzz_metric', evidence: {},
        }]);
      }
      return resolve([]);
    };
    return chain;
  }

  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => ({
        values: (vals: Record<string, unknown>) => ({
          returning: () => {
            const row = { id: `sugg-${h.insertedRows.length + 1}`, ...vals };
            h.insertedRows.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    },
  };
});

vi.mock('../db/schema', () => h.tables);

vi.mock('./mlFeatureFlags', () => ({
  shouldProduceMlOutput: vi.fn().mockResolvedValue(true),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./fixMemory/attach', () => ({ attachProvenFixes: vi.fn(async () => 1) }));
vi.mock('./fixMemory/research', () => ({
  requestResearch: vi.fn(async () => ({ status: 'started', runId: 'run-1', depth: 'quick' })),
}));

import { __testOnly, generateRemediationSuggestions } from './remediationSuggestions';
import { shouldProduceMlOutput } from './mlFeatureFlags';
import { attachProvenFixes } from './fixMemory/attach';
import { requestResearch } from './fixMemory/research';

describe('Generate = memory first, then quick research (keyword matcher retired)', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    h.rows = {};
    vi.clearAllMocks();
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(true);
  });

  it('attaches memory and starts quick research when allowed', async () => {
    const out = await generateRemediationSuggestions({ sourceType: 'anomaly', sourceId: 'anomaly-1', actorUserId: 'u-1', allowResearch: true });
    expect(attachProvenFixes).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'anomaly-1', orgId: 'org-1' }));
    expect(requestResearch).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', sourceType: 'anomaly', sourceId: 'anomaly-1', depth: 'quick', trigger: 'manual', actorUserId: 'u-1',
    }));
    expect(out.skipped).toBe(false);
    expect(out.research).toEqual({ status: 'started', runId: 'run-1', depth: 'quick' });
  });

  it('without research permission it is memory-only and says so', async () => {
    const out = await generateRemediationSuggestions({ sourceType: 'anomaly', sourceId: 'anomaly-1', actorUserId: 'u-1', allowResearch: false });
    expect(attachProvenFixes).toHaveBeenCalled();
    expect(requestResearch).not.toHaveBeenCalled();
    expect(out.research).toEqual({ status: 'denied', code: 'permission', message: expect.any(String) });
  });

  it('a throwing requestResearch still returns Generate with research denied (memory never depends on research)', async () => {
    vi.mocked(requestResearch).mockRejectedValueOnce(new Error('boom'));
    const out = await generateRemediationSuggestions({ sourceType: 'anomaly', sourceId: 'anomaly-1', actorUserId: 'u-1', allowResearch: true });
    expect(attachProvenFixes).toHaveBeenCalled();
    expect(out.skipped).toBe(false);
    expect(out.research).toEqual({ status: 'denied', code: 'research_unavailable', message: expect.any(String) });
  });

  it('an rca source never starts research', async () => {
    const out = await generateRemediationSuggestions({ sourceType: 'rca', sourceId: 'rca-1', orgId: 'org-1', allowResearch: true });
    expect(requestResearch).not.toHaveBeenCalled();
    expect(out.research).toBeNull();
  });

  it('never writes a keyword-matched row any more', async () => {
    await generateRemediationSuggestions({ sourceType: 'anomaly', sourceId: 'anomaly-1', allowResearch: false });
    expect(insertedRows).toEqual([]);
  });

  it('is skipped (no memory, no research) when the feature flag is off', async () => {
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(false);
    const out = await generateRemediationSuggestions({ sourceType: 'anomaly', sourceId: 'anomaly-1', allowResearch: true });
    expect(out).toMatchObject({ skipped: true, suggestions: [], research: null });
    expect(attachProvenFixes).not.toHaveBeenCalled();
    expect(requestResearch).not.toHaveBeenCalled();
  });
});

describe('remediation suggestion source context', () => {
  it('builds RCA suggestion context from correlation group metadata', () => {
    const context = __testOnly.rcaContextFromCorrelationGroup({
      id: 'group-1',
      orgId: 'org-1',
      rootAlertId: 'alert-1',
      groupKey: 'site:server-room',
      status: 'open',
      metadata: {
        logCorrelationRuleNames: ['Service crash burst'],
        logPatterns: ['service crashed'],
        flappingDetected: true,
      },
    }, {
      sourceType: 'rca',
      sourceId: 'group-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
    });

    expect(context).toMatchObject({
      sourceType: 'rca',
      sourceId: 'group-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
      alertId: 'alert-1',
      correlationGroupId: 'group-1',
      rcaId: 'group-1',
      title: 'RCA for correlation group site:server-room',
    });
  });
});
