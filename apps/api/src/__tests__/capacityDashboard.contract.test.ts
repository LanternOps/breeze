/**
 * Scaling W07 (#8146): the agent-capacity dashboard and the
 * `breeze-capacity-kpis` recording-rule group may only reference series that
 * are really published. A panel on a series that does not exist renders
 * "No data" and nobody notices; a rule on one never produces a sample.
 *
 * Every metric name in every rule `expr` and every dashboard query must be
 * (a) registered in the live metrics registry, (b) defined by a `record:` in
 * the group, or (c) an explicitly allowlisted exporter series.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services', () => ({}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(),
  requirePermission: vi.fn(() => vi.fn()),
  requireScope: vi.fn(() => vi.fn()),
}));

import '../routes/metrics';
import '../services/metricsRuntime';
import '../services/admission/admissionMetrics';
import { metricsRegistry } from '../services/metricsRegistry';

const REPO_ROOT = resolve(__dirname, '../../../..');
const DASHBOARD_PATH = resolve(REPO_ROOT, 'monitoring/grafana/dashboards/breeze-agent-capacity.json');
const RULES_PATH = resolve(REPO_ROOT, 'monitoring/rules/breeze-rules.yml');
const ROUTE_LIST_PATH = resolve(__dirname, 'writeRoutePermissionGate.contract.test.ts');

const HEARTBEAT_ROUTE = '/api/v1/agents/:id/heartbeat';

/** Series published by an exporter, not by the API process. */
const EXPORTER_ALLOWLIST: Record<string, string> = {
  pg_stat_database_xact_commit: 'postgres-exporter',
};

const PROMQL_WORDS = new Set([
  'rate', 'irate', 'increase', 'count', 'sum', 'avg', 'max', 'min', 'by', 'without', 'on', 'ignoring',
  'group_left', 'group_right', 'bool', 'and', 'or', 'unless', 'offset', 'histogram_quantile',
  'max_over_time', 'min_over_time', 'avg_over_time', 'quantile_over_time', 'label_values',
  'clamp_min', 'clamp_max', 'vector', 'scalar', 'topk', 'bottomk', 'round', 'abs',
]);

/**
 * Metric names in a PromQL expression, by tokenising: strip string literals,
 * `{…}` matcher bodies, `[…]` ranges, durations, numbers, Grafana variables
 * and the label lists after by/without/on/ignoring/group_left/group_right, then
 * keep every identifier that is not a PromQL keyword or function.
 */
export function metricNames(expr: string): string[] {
  let s = expr;
  s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, ' ');
  s = s.replace(/\{[^}]*\}/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, ' ');
  s = s.replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' $1 ');
  s = s.replace(/\b\d+(?:ms|s|m|h|d|w|y)\b/g, ' ');
  s = s.replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, ' ');
  const tokens = s.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? [];
  return [...new Set(tokens.filter((t) => !PROMQL_WORDS.has(t)))];
}

interface RuleEntry { record: string; expr: string }

/** The `breeze-capacity-kpis` group, sliced as text (apps/api has no YAML parser). */
function capacityRuleGroup(): RuleEntry[] {
  const text = readFileSync(RULES_PATH, 'utf8');
  const start = text.indexOf('  - name: breeze-capacity-kpis\n');
  expect(start, 'breeze-capacity-kpis group missing from breeze-rules.yml').toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {2}- name: /m);
  const group = next === -1 ? rest : rest.slice(0, next);
  const entries: RuleEntry[] = [];
  for (const block of group.split(/^ {6}- record: /m).slice(1)) {
    const record = block.split('\n')[0]!.trim();
    const exprMatch = block.match(/^ {8}expr: (\|[-+]?\n(?:(?: {10}.*)?\n)*|.*)$/m);
    expect(exprMatch, `rule ${record} has no expr`).not.toBeNull();
    const raw = exprMatch![1]!;
    const expr = raw.startsWith('|') ? raw.split('\n').slice(1).join('\n') : raw;
    entries.push({ record, expr });
  }
  return entries;
}

interface DashboardQuery { title: string; expr: string }

type Panel = { title?: string; type?: string; targets?: Array<{ expr?: string }>; panels?: Panel[] };
interface Dashboard {
  uid: string;
  panels: Panel[];
  templating: { list: Array<{ name: string; includeAll?: boolean; allValue?: string; query?: unknown; definition?: string }> };
}

function loadDashboard(): Dashboard {
  return JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8')) as Dashboard;
}

function dashboardQueries(d: Dashboard): DashboardQuery[] {
  const out: DashboardQuery[] = [];
  const walk = (panels: Panel[]) => {
    for (const p of panels) {
      for (const t of p.targets ?? []) if (t.expr) out.push({ title: p.title ?? '(untitled)', expr: t.expr });
      if (p.panels) walk(p.panels);
    }
  };
  walk(d.panels);
  return out;
}

/** label_values(<selector>, <label>) — only the selector's metric is a metric. */
function templateQueries(d: Dashboard): DashboardQuery[] {
  return d.templating.list.flatMap((v) => {
    const q = typeof v.query === 'string' ? v.query : (v.query as { query?: string } | undefined)?.query;
    const m = q?.match(/label_values\(\s*(.*),\s*[A-Za-z_][A-Za-z0-9_]*\s*\)\s*$/);
    return m ? [{ title: `variable $${v.name}`, expr: m[1]! }] : [];
  });
}

function resolveName(name: string, recorded: Set<string>): boolean {
  const base = name.replace(/_(bucket|sum|count)$/, '');
  return Boolean(
    metricsRegistry.getSingleMetric(name)
    || metricsRegistry.getSingleMetric(base)
    || recorded.has(name)
    || EXPORTER_ALLOWLIST[name],
  );
}

describe('metricNames tokeniser', () => {
  it('finds bare names, selected names and recording-rule names, not labels or functions', () => {
    expect(metricNames('breeze_admission_level').sort()).toEqual(['breeze_admission_level']);
    expect(metricNames('sum by (region, instance) (rate(foo_total{job=~"breeze-api.*", region=~"$region"}[5m]))'))
      .toEqual(['foo_total']);
    expect(metricNames('histogram_quantile(0.95, sum by (region, le) (rate(x_bucket{route="/a/b"}[5m]))) * 1e6'))
      .toEqual(['x_bucket']);
    expect(metricNames('breeze:a:instance / (breeze:b:region > 0)').sort()).toEqual(['breeze:a:instance', 'breeze:b:region']);
    expect(metricNames('max_over_time(lag_seconds[5m]) offset 1h')).toEqual(['lag_seconds']);
  });
});

describe('capacity dashboard and rule group contract (#8146)', () => {
  it('every metric in the breeze-capacity-kpis rule group is published or recorded', () => {
    const rules = capacityRuleGroup();
    expect(rules.length).toBeGreaterThanOrEqual(11);
    const recorded = new Set(rules.map((r) => r.record));
    const unresolved: string[] = [];
    for (const r of rules) {
      const names = metricNames(r.expr);
      expect(names.length, `rule ${r.record} references no metric`).toBeGreaterThan(0);
      for (const n of names) if (!resolveName(n, recorded)) unresolved.push(`${n} (rule ${r.record})`);
    }
    expect(unresolved).toEqual([]);
  });

  it('every metric in every dashboard query is published, recorded or allowlisted', () => {
    const d = loadDashboard();
    const recorded = new Set(capacityRuleGroup().map((r) => r.record));
    const queries = [...dashboardQueries(d), ...templateQueries(d)];
    expect(queries.length).toBeGreaterThanOrEqual(15);
    const unresolved: string[] = [];
    for (const q of queries) {
      const names = metricNames(q.expr);
      expect(names.length, `panel "${q.title}" query references no metric: ${q.expr}`).toBeGreaterThan(0);
      for (const n of names) if (!resolveName(n, recorded)) unresolved.push(`${n} (panel "${q.title}")`);
    }
    expect(unresolved).toEqual([]);
  });

  it('every route matcher is the live heartbeat template or an agent-route regex', () => {
    const exprs = [
      ...capacityRuleGroup().map((r) => ({ where: `rule ${r.record}`, expr: r.expr })),
      ...dashboardQueries(loadDashboard()).map((q) => ({ where: `panel "${q.title}"`, expr: q.expr })),
    ];
    const bad: string[] = [];
    let heartbeatMatchers = 0;
    for (const { where, expr } of exprs) {
      for (const m of expr.matchAll(/\broute\s*(=~|!=|!~|=)\s*"([^"]*)"/g)) {
        const [, op, value] = m;
        if (op === '=' && value === HEARTBEAT_ROUTE) { heartbeatMatchers++; continue; }
        if (op === '=~' && value!.startsWith('/api/v1/agents/')) continue;
        bad.push(`${where}: route${op}"${value}"`);
      }
    }
    expect(bad).toEqual([]);
    expect(heartbeatMatchers).toBeGreaterThan(0);
    // A renamed route must red this test too: the template must still be in the write-route list.
    expect(readFileSync(ROUTE_LIST_PATH, 'utf8')).toContain(`'POST ${HEARTBEAT_ROUTE}'`);
  });

  it('has region and instance variables defaulting to All with allValue ".*", used as regex matchers', () => {
    const d = loadDashboard();
    for (const name of ['region', 'instance']) {
      const v = d.templating.list.find((x) => x.name === name);
      expect(v, `template variable ${name}`).toBeDefined();
      expect(v!.includeAll).toBe(true);
      expect(v!.allValue).toBe('.*');
    }
    const misuse: string[] = [];
    for (const q of [...dashboardQueries(d), ...templateQueries(d)]) {
      for (const m of q.expr.matchAll(/(\w+)\s*(=~|!=|!~|=)\s*"([^"]*\$\{?(region|instance)\}?[^"]*)"/g)) {
        const [whole, label, op, value, varName] = m;
        if (label !== varName || op !== '=~' || value !== `$${varName}`) misuse.push(`panel "${q.title}": ${whole}`);
      }
    }
    expect(misuse).toEqual([]);
  });

  it('has the expected uid and no infrastructure details', () => {
    const raw = readFileSync(DASHBOARD_PATH, 'utf8');
    expect(loadDashboard().uid).toBe('breeze-agent-capacity');
    expect(raw).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    const hosts = (raw.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|internal|local|lan|host)\b/gi) ?? [])
      .filter((h) => !/^(?:grafana\.com)$/i.test(h));
    expect(hosts).toEqual([]);
  });
});
