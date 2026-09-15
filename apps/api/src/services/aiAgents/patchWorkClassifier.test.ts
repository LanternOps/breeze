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

import { PATCH_ALERT_CATEGORY } from '@breeze/shared';
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

  it('fails closed when the read throws — never propagates into admission', async () => {
    results = [new Error('boom')];
    expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
  });

  it('pins org on every leg in ONE statement', async () => {
    results = [[{ rule_id: 'r', monitor_id: null, template_category: PATCH_ALERT_CATEGORY, monitor_kind: null }]];
    await classifyAlertAsPatchWork(ALERT, ORG);
    expect(executed).toHaveLength(1);
    const text = sqlText(executed[0]).replace(/\s+/g, ' ');
    expect(text).toContain('LEFT JOIN alert_rules');
    expect(text).toContain('LEFT JOIN alert_templates');
    expect(text).toContain('LEFT JOIN monitor_definitions');
    // alerts.org_id pinned, and the monitor leg pinned to the org OR partner-wide.
    expect(text).toContain('a.org_id =');
    expect(boundParams(executed[0]).filter((p) => p === ORG).length).toBeGreaterThanOrEqual(2);
    expect(boundParams(executed[0])).toContain(ALERT);
  });
});

describe('resolveAlertCategory', () => {
  it('returns the template category and the monitor kind for the trigger filter', async () => {
    results = [[{ rule_id: 'r', monitor_id: 'm', template_category: 'monitor', monitor_kind: 'patch_compliance' }]];
    expect(await resolveAlertCategory(ALERT, ORG)).toEqual({ category: 'monitor', monitorKind: 'patch_compliance', isPatchWork: true });
  });

  it('returns nulls (not patch work) when nothing resolves', async () => {
    results = [[]];
    expect(await resolveAlertCategory(ALERT, ORG)).toEqual({ category: null, monitorKind: null, isPatchWork: false });
  });
});
