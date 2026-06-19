import { describe, expect, it, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (which are themselves hoisted) can read them.
const h = vi.hoisted(() => {
  const TABLE = '__table__';
  const tbl = (name: string, extra: Record<string, string> = {}) => ({ [TABLE]: name, ...extra });
  return {
    TABLE,
    insertedRows: [] as Array<Record<string, unknown>>,
    tables: {
      alertCorrelationGroups: tbl('alertCorrelationGroups'),
      alerts: tbl('alerts'),
      devices: tbl('devices'),
      metricAnomalies: tbl('metricAnomalies'),
      playbookDefinitions: tbl('playbookDefinitions', { id: 'p', name: 'p', description: 'p', category: 'p', isBuiltIn: 'p', isActive: 'p', orgId: 'p' }),
      remediationSuggestions: tbl('remediationSuggestions', { orgId: 'r', sourceType: 'r', sourceId: 'r', targetType: 'r', scriptId: 'r', scriptTemplateId: 'r', playbookId: 'r' }),
      scripts: tbl('scripts', { id: 's', name: 's', description: 's', category: 's', runAs: 's', deletedAt: 's', isSystem: 's', orgId: 's', updatedAt: 's' }),
      scriptTemplates: tbl('scriptTemplates', { id: 't', name: 't', description: 't', category: 't', rating: 't', downloads: 't' }),
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
      // Source-context lookups + candidate lists + existing all resolve empty
      // so generateRemediationSuggestions falls through to the fallback nudge.
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

import { __testOnly, generateRemediationSuggestions } from './remediationSuggestions';
import { shouldProduceMlOutput } from './mlFeatureFlags';

describe('generateRemediationSuggestions fallback tagging', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(true);
  });

  it('tags the persisted fallback row and sets usedFallback when nothing matches', async () => {
    const result = await generateRemediationSuggestions({
      sourceType: 'anomaly',
      sourceId: 'anomaly-1',
    });

    expect(result.skipped).toBe(false);
    expect(result.usedFallback).toBe(true);
    expect(result.suggestions).toHaveLength(1);

    const persisted = insertedRows[0];
    expect(persisted).toBeDefined();
    expect(persisted!.targetType).toBe('diagnostic');
    expect(persisted!.evidence).toMatchObject({ fallback: true, reason: 'no_term_match' });
  });

  it('reports usedFallback=false and no rows when ML output is disabled', async () => {
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(false);
    const result = await generateRemediationSuggestions({
      sourceType: 'anomaly',
      sourceId: 'anomaly-1',
    });

    expect(result.skipped).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(insertedRows).toHaveLength(0);
  });
});

describe('remediation suggestion heuristics', () => {
  it('maps network egress anomalies to network/security remediation terms', () => {
    const terms = __testOnly.termsForSource({
      sourceType: 'anomaly',
      sourceId: 'anomaly-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
      alertId: null,
      anomalyId: 'anomaly-1',
      correlationGroupId: null,
      rcaId: null,
      title: 'network_egress on bandwidth_out_bps',
      text: 'network_egress network bandwidth_out_bps',
      anomalyType: 'network_egress',
      metricName: 'bandwidth_out_bps',
    });

    expect(terms).toEqual(expect.arrayContaining(['network', 'egress', 'security']));
  });

  it('scores script library candidates by matched terms', () => {
    const result = __testOnly.scoreCandidate('disk cleanup temp storage maintenance', ['disk', 'cleanup', 'network']);

    expect(result.matchedTerms).toEqual(['disk', 'cleanup']);
    expect(result.score).toBeCloseTo(2 / 3);
  });

  it('raises risk for destructive or restart-style actions', () => {
    const context = {
      sourceType: 'alert' as const,
      sourceId: 'alert-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
      alertId: 'alert-1',
      anomalyId: null,
      correlationGroupId: null,
      rcaId: null,
      title: 'Disk full',
      text: 'disk full',
      severity: 'critical',
    };

    expect(__testOnly.riskTierForCandidate(context, 'delete temp cleanup')).toBe('high');
    expect(__testOnly.riskTierForCandidate(context, 'restart service')).toBe('medium');
  });

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
    expect(context.text).toContain('service crash burst');
    expect(context.text).toContain('service crashed');
    expect(context.text).toContain('flappingdetected');
  });
});
