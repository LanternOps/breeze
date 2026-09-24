/**
 * AI patch agent W04 (#5750) — `classifyAlertAsPatchWork` is join-based and
 * FAILS CLOSED: `alerts` has no category column, both join legs are nullable,
 * and anything that does not positively resolve to the patch category (or a
 * `patch_compliance` monitor) is "not patch work" — triage keeps it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executed: unknown[] = [];
let results: unknown[] = [];

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn((statement: unknown) => {
      executed.push(statement);
      const next = results.length > 0 ? results.shift() : [];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  },
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { PATCH_ALERT_CATEGORY } from '@breeze/shared';
import { captureException } from '../sentry';
import { classifyAlertAsPatchWork, resolveAlertCategory } from './patchWorkClassifier';

function sqlText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(sqlText).join('');
  if (Array.isArray(n.value) && !('encoder' in n)) return (n.value as unknown[]).join('');
  return '';
}
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundParams(chunk, out);
    return out;
  }
  if ('encoder' in n && 'value' in n) out.push(n.value);
  return out;
}

const ALERT = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';

beforeEach(() => {
  executed.length = 0;
  results = [];
});

describe('classifyAlertAsPatchWork', () => {
  it('classifies via alert_rules.template_id -> alert_templates.category', async () => {
    results = [[{ rule_id: 'r', monitor_id: null, template_category: PATCH_ALERT_CATEGORY, monitor_kind: null }]];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(true);
  });

  it('classifies via alerts.monitor_id -> monitor_definitions.kind = patch_compliance', async () => {
    results = [[{ rule_id: 'r', monitor_id: 'm', template_category: 'monitor', monitor_kind: 'patch_compliance' }]];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(true);
  });

  it('FAILS CLOSED when rule_id and monitor_id are both null', async () => {
    results = [[{ rule_id: null, monitor_id: null, template_category: null, monitor_kind: null }]];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
  });

  it('fails closed when the join legs resolve but the category is null', async () => {
    results = [[{ rule_id: 'r', monitor_id: 'm', template_category: null, monitor_kind: 'cpu' }]];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
  });

  it('fails closed for a non-patch category and a non-patch monitor kind', async () => {
    results = [[{ rule_id: 'r', monitor_id: 'm', template_category: 'monitor', monitor_kind: 'disk' }]];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
  });

  it('fails closed when the alert is not in the org (no row)', async () => {
    results = [[]];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
  });

  it('fails closed when the read throws — never propagates into admission — and reports it to Sentry', async () => {
    results = [new Error('boom')];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ operation: 'resolveAlertCategory', alertId: ALERT, orgId: ORG }));
  });

  it('pins org on every leg in ONE statement', async () => {
    results = [[{ rule_id: 'r', monitor_id: null, template_category: PATCH_ALERT_CATEGORY, monitor_kind: null }]];
    await classifyAlertAsPatchWork(ALERT, ORG);
    expect(executed).toHaveLength(1);
    const text = sqlText(executed[0]).replace(/\s+/g, ' ');
    expect(text).toContain('LEFT JOIN alert_rules');
    expect(text).toContain('LEFT JOIN alert_templates');
    expect(text).toContain('LEFT JOIN monitor_definitions');
    // alerts.org_id pinned, and EVERY joined leg pinned to the org or a
    // partner-wide/global row — one dropped predicate is a cross-tenant read.
    expect(text).toContain('a.org_id =');
    // (`sqlText` elides the bound parameter, so `= OR` is the param slot.)
    expect(text).toContain('ON r.id = a.rule_id AND (r.org_id = OR r.org_id IS NULL)');
    expect(text).toContain('ON t.id = r.template_id AND (t.org_id = OR t.org_id IS NULL)');
    expect(text).toContain('ON m.id = a.monitor_id AND (m.org_id = OR m.org_id IS NULL)');
    expect(boundParams(executed[0]).filter((p) => p === ORG).length).toBe(4);
    expect(boundParams(executed[0])).toContain(ALERT);
  });
});

describe('resolveAlertCategory', () => {
  it('returns the template category and the monitor kind for the trigger filter', async () => {
    results = [[{ rule_id: 'r', monitor_id: 'm', template_category: 'monitor', monitor_kind: 'patch_compliance', alert_source: null }]];
    expect(await resolveAlertCategory(ALERT, ORG)).toEqual({
      category: 'monitor', monitorKind: 'patch_compliance', isPatchWork: true, source: null,
    });
  });

  it('returns nulls (not patch work) when nothing resolves', async () => {
    results = [[]];
    expect(await resolveAlertCategory(ALERT, ORG)).toEqual({
      category: null, monitorKind: null, isPatchWork: false, source: null,
    });
  });

  // #6749 — the same read surfaces the alert's lifecycle source so the
  // `ai_triage` admission path can exclude warranty/lifecycle alerts.
  it('returns the alert context.source for the lifecycle exclusion', async () => {
    results = [[{ rule_id: null, monitor_id: null, template_category: null, monitor_kind: null, alert_source: 'warranty_evaluator' }]];
    expect(await resolveAlertCategory(ALERT, ORG)).toEqual({
      category: null, monitorKind: null, isPatchWork: false, source: 'warranty_evaluator',
    });
  });
});
