import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { carryOpenAlerts, restoreMovedAlertRefs, canDeleteConversionMonitor } from './history';
vi.mock('../../../db', () => ({ db: {} }));
vi.mock('./loadSources', () => ({ OPEN_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'] }));

it('locks open alerts before moving references, preserving context without changing org or status', async () => {
  const events: string[] = [];
  const original = { id: 'alert', ruleId: 'legacy', configPolicyId: null, monitorId: null, context: { retained: true } };
  const set = vi.fn(() => ({ where: async () => { events.push('update'); } }));
  const where = vi.fn((_predicate: unknown) => ({ for: async (lock: string) => { events.push(`lock:${lock}`); return [original]; } }));
  const tx = { select: () => ({ from: () => ({ where }) }), update: () => ({ set }) };
  const refs = await carryOpenAlerts(tx as never, { sourceTable: 'alert_templates', sourceId: 'template', ruleId: 'legacy', compiledRuleId: 'compiled', monitorId: 'monitor' });
  expect(events).toEqual(['lock:update', 'update']);
  expect(refs).toEqual([original]);
  expect(set).toHaveBeenCalledWith({ ruleId: 'compiled', configPolicyId: null, monitorId: 'monitor', context: { retained: true, convertedFrom: { sourceTable: 'alert_templates', sourceId: 'template', ruleId: 'legacy' } } });
  const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
  expect(query.params).toEqual(['legacy', 'active', 'acknowledged', 'suppressed']);
});

it.each([{ context: ['legacy'] }, { context: 'legacy' }, { context: 7 }])('refuses non-object historical context before any mutation: $context', async ({ context }) => {
  const update = vi.fn();
  const tx = { select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: 'alert', context }] }) }) }), update };
  await expect(carryOpenAlerts(tx as never, { sourceTable: 'config_policy_alert_rules', sourceId: 'source', compiledRuleId: 'compiled', monitorId: 'monitor' })).rejects.toThrow('context');
  expect(update).not.toHaveBeenCalled();
});

it('restores exact standalone references and context before deletion is considered', async () => {
  const set = vi.fn(() => ({ where: async () => [] }));
  const tx = { update: () => ({ set }) };
  const original = { id: 'alert', ruleId: 'legacy-rule', configPolicyId: null, monitorId: null, context: { retained: true, convertedFrom: { original: true } } };
  await restoreMovedAlertRefs(tx as never, [original]);
  const { id, ...refs } = original;
  expect(set).toHaveBeenCalledWith(refs);
});

it.each([[[{ id: 'another-output' }], [], []], [[], [{ id: 'attachment' }], []], [[], [], [{ id: 'history' }]], [[], [], []]])('retains every referenced monitor (case %#)', async (live, attachments, history) => {
  const results = [live, attachments, history, []];
  const query = () => {
    const rows = results.shift()!;
    const chain: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = () => chain;
    return chain;
  };
  expect(await canDeleteConversionMonitor({ select: query } as never, 'monitor', 'first-conversion')).toBe(!live.length && !attachments.length && !history.length);
});

it('retains a compiled template used by an unmanaged deployment, including inactive or retired rules', async () => {
  const results = [[], [], [], [{ id: 'unmanaged-rule' }]];
  const predicates: unknown[] = [];
  const joins: unknown[] = [];
  const query = () => {
    const rows = results.shift()!;
    const chain: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    chain.from = () => chain;
    chain.innerJoin = (_table: unknown, predicate: unknown) => { joins.push(predicate); return chain; };
    chain.where = (predicate: unknown) => { predicates.push(predicate); return chain; };
    chain.limit = () => chain;
    return chain;
  };
  expect(await canDeleteConversionMonitor({ select: query } as never, 'monitor', 'conversion')).toBe(false);
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(joins.at(-1) as never).sql).toContain('"compiled_alert_template_id"');
  const sql = dialect.sqlToQuery(predicates.at(-1) as never).sql;
  expect(sql).toContain('"managed_by_monitor_id" is null');
  expect(sql).not.toContain('"retired_at"');
  expect(sql).not.toContain('"is_active"');
});
