import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A8 — the conversion census: aggregates only,
 * system context, never an id or a name (it is run on production and only its
 * numbers leave the host).
 *
 * Flows completion W02a (#12439) adds class C, the not-form-shaped count and
 * `webhookScriptJobs` (plan decisions P9, P10); the leak tests push an id and
 * a name through each of those paths.
 */

const m = vi.hoisted(() => ({
  rows: [] as unknown[],
  conversions: [] as unknown[],
  policyRows: [] as Array<Record<string, unknown>>,
  context: vi.fn(),
  recognize: vi.fn(),
}));

/**
 * The mock returns whole rows whatever the projection, so a census that copied
 * a row field into its output would leak it here. `isNull(col)` becomes a
 * marker the `where` applies, so the C read's retired filter is exercised.
 */
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  isNull: (col: unknown) => ({ __isNull: col }),
}));
vi.mock('../../../db', () => ({
  db: {
    select: () => ({
      from: (t: { _: string }) => ({
        where: async (pred?: { __isNull?: { key: string } }) => {
          if (t._ === 'conversions') return m.conversions;
          if (t._ === 'policyAutomations') {
            const col = pred?.__isNull?.key;
            return col ? m.policyRows.filter((r) => r[col] == null) : m.policyRows;
          }
          return m.rows;
        },
      }),
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../../db/schema', () => ({
  automations: { _: 'automations', retiredAt: {}, managedByMonitorId: {} },
  flowAutomationConversions: { _: 'conversions', state: {} },
  configPolicyAutomations: { _: 'policyAutomations', enabled: { key: 'enabled' }, retiredAt: { key: 'retiredAt' } },
}));
vi.mock('./context', () => ({ loadConversionContext: m.context }));
vi.mock('@breeze/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breeze/shared')>();
  m.recognize.mockImplementation(actual.recognizeFlowForm);
  return { ...actual, recognizeFlowForm: (doc: unknown) => m.recognize(doc) };
});

import { conversionCensus } from './census';
import { CHANNEL, SCRIPT, ctx, row } from './__fixtures__/automations';

const NOW = new Date('2027-02-01T00:00:00Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policyId = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINK = 'dddddddd-0000-4000-8000-000000000001';

/** A converted `execute_command` Job is not form-shaped; the default fixture row is. */
const COMMAND = [{ type: 'execute_command', command: 'echo CustomerSecretCommand' }];
const SCRIPT_ACTION = [{ type: 'run_script', scriptId: SCRIPT }];
const NOTIFY_ONLY = [{ type: 'send_notification', notificationChannelId: CHANNEL, title: 'Initech alert', message: 'm' }];
/** Converts to no document (`notify_per_run_cap` makes it unconvertible). */
const UNCONVERTIBLE = [...SCRIPT_ACTION, ...NOTIFY_ONLY];
const WEBHOOK = { type: 'webhook', secret: 's' };

function policyRow(n: number, over: Record<string, unknown> = {}) {
  return { id: policyId(n), featureLinkId: LINK, name: `Customer Globex policy job ${n}`, enabled: true, retiredAt: null, actions: COMMAND, ...over };
}

/** Every leaf of the census is a number or null: no string can carry row content. */
function leaves(v: unknown, path = 'census'): Array<[string, unknown]> {
  if (v !== null && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => leaves(x, `${path}.${k}`));
  return [[path, v]];
}

beforeEach(() => {
  m.rows = [];
  m.conversions = [];
  m.policyRows = [];
  m.context.mockReset().mockImplementation(async () => ctx());
  m.recognize.mockClear();
});

describe('conversionCensus', () => {
  it('counts classes, fidelities, findings and switched rows', async () => {
    m.rows = [
      row({ id: id(1) }),
      row({ id: id(2), enabled: false, trigger: { type: 'webhook', secret: 's' } }),
      row({ id: id(3), managedByMonitorId: 'm' }),
      row({ id: id(4), managedByAgentId: 'a' }),
      row({ id: id(5), trigger: { type: 'event', eventType: 'x', filter: { _policyWorkflow: {} } } }),
    ];
    m.conversions = [
      { automationId: id(1), state: 'switched', switchedAt: new Date('2027-01-01T00:00:00Z') },
    ];
    const c = await conversionCensus(NOW);
    expect(c.byClass).toEqual({
      M: { total: 1, enabled: 1 }, A: { total: 1, enabled: 1 }, P: { total: 1, enabled: 1 }, S: { total: 2, enabled: 1 }, C: { total: 0, enabled: 0 },
    });
    expect(c.switched).toBe(1);
    expect(c.enabledUnswitchedS).toBe(0);
    expect(c.oldestSwitchAgeMs).toBe(31 * 86_400_000);
    expect(c.byFidelity.exact + c.byFidelity.needs_review + c.byFidelity.unconvertible).toBe(2);
    expect(c.byFinding.webhook_body_shape).toBe(1);
  });

  it('R rows counted separately', async () => {
    m.rows = [row({ id: id(1) }), row({ id: id(2) })];
    m.context.mockImplementationOnce(async () => ctx({ isRemediationTarget: true }));
    const c = await conversionCensus(NOW);
    expect(c.remediationTargets).toBe(1);
    expect(c.enabledUnswitchedS).toBe(2);
    expect(c.byFinding.compliance_remediation_target).toBe(1);
  });

  it('counts class C rows that are not retired', async () => {
    m.policyRows = [
      policyRow(1),
      policyRow(2, { enabled: false }),
      policyRow(3, { retiredAt: new Date('2026-12-01T00:00:00Z') }),
      policyRow(4, { enabled: false, retiredAt: new Date('2026-12-01T00:00:00Z') }),
    ];
    const c = await conversionCensus(NOW);
    expect(c.byClass.C).toEqual({ total: 2, enabled: 1 });
    // C rows are config-policy automations, never S rows: nothing else moves.
    expect(c.byClass.S).toEqual({ total: 0, enabled: 0 });
    expect(c.enabledUnswitchedS).toBe(0);
  });

  it('counts enabled unswitched S rows the editor cannot open in the form', async () => {
    m.rows = [
      row({ id: id(1), actions: COMMAND }), // counted
      row({ id: id(2) }), // form-shaped
      row({ id: id(3), actions: COMMAND, enabled: false }), // disabled
      row({ id: id(4), actions: COMMAND }), // switched
      row({ id: id(5), actions: UNCONVERTIBLE }), // no document
      row({ id: id(6), actions: COMMAND }), // context error
      row({ id: id(7), actions: COMMAND }), // remediation target: no document
      row({ id: id(8), actions: COMMAND, managedByMonitorId: 'm' }), // class M
    ];
    m.conversions = [{ automationId: id(4), state: 'switched', switchedAt: new Date('2027-01-01T00:00:00Z') }];
    m.context.mockImplementation(async (r: { id: string }) => {
      if (r.id === id(6)) throw new Error('no owner');
      return ctx({ isRemediationTarget: r.id === id(7) });
    });
    const c = await conversionCensus(NOW);
    expect(c.notFormShapedEnabledUnswitchedS).toBe(1);
    expect(c.byFidelity.unconvertible).toBeGreaterThanOrEqual(1);
    expect(c.contextErrors).toBe(1);
  });

  it('a recognizer that throws counts the row as not form-shaped and leaks nothing', async () => {
    m.rows = [row({ id: id(1), name: 'Customer Hooli backup' })];
    m.recognize.mockImplementationOnce(() => {
      throw new Error(`cannot decode ${id(1)} Customer Hooli backup`);
    });
    const c = await conversionCensus(NOW);
    expect(m.recognize).toHaveBeenCalledTimes(1);
    expect(c.notFormShapedEnabledUnswitchedS).toBe(1);
    const text = JSON.stringify(c);
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain('Hooli');
  });

  it('counts webhook Jobs that run a script', async () => {
    m.rows = [
      row({ id: id(1), trigger: WEBHOOK, actions: SCRIPT_ACTION }), // counted
      row({ id: id(2), trigger: WEBHOOK, actions: [...NOTIFY_ONLY, ...COMMAND] }), // counted
      row({ id: id(3), trigger: WEBHOOK, actions: SCRIPT_ACTION, enabled: false }), // disabled
      row({ id: id(4), trigger: WEBHOOK, actions: SCRIPT_ACTION }), // switched
      row({ id: id(5), trigger: WEBHOOK, actions: NOTIFY_ONLY }), // no script
      row({ id: id(6), actions: SCRIPT_ACTION }), // schedule trigger
      row({ id: id(7), trigger: WEBHOOK, actions: SCRIPT_ACTION, managedByMonitorId: 'm' }), // class M
      row({ id: id(8), trigger: { ...WEBHOOK, filter: { _policyWorkflow: {} } }, actions: SCRIPT_ACTION }), // class P
      row({ id: id(9), trigger: WEBHOOK, actions: SCRIPT_ACTION, retiredAt: new Date('2026-12-01T00:00:00Z') }), // retired
      row({ id: id(10), trigger: null, actions: null } as never), // malformed jsonb: not counted, not thrown
      row({ id: id(11), trigger: WEBHOOK, actions: { type: 'run_script' } } as never), // actions not an array
    ];
    m.conversions = [{ automationId: id(4), state: 'switched', switchedAt: new Date('2027-01-01T00:00:00Z') }];
    const c = await conversionCensus(NOW);
    expect(c.webhookScriptJobs).toBe(2);
  });

  it('census output contains no uuid', async () => {
    m.rows = [
      row({ id: id(1), name: 'Customer Acme payroll' }),
      row({ id: id(2), trigger: WEBHOOK, actions: SCRIPT_ACTION }),
      row({ id: id(3), actions: COMMAND }),
      row({ id: id(4), actions: UNCONVERTIBLE }),
    ];
    m.conversions = [{ automationId: id(1), state: 'switched', switchedAt: new Date('2027-01-01T00:00:00Z') }];
    m.policyRows = [policyRow(1), policyRow(2, { retiredAt: new Date('2026-12-01T00:00:00Z') })];
    const c = await conversionCensus(NOW);
    // Each new path was exercised, so a leak through any of them would show.
    expect(c.byClass.C.total).toBe(1);
    expect(c.webhookScriptJobs).toBe(1);
    expect(c.notFormShapedEnabledUnswitchedS).toBe(1);
    const text = JSON.stringify(c);
    expect(text).not.toMatch(UUID);
    for (const [path, value] of leaves(c)) expect(value === null || typeof value === 'number', path).toBe(true);
  });

  it('the census still never prints a name', async () => {
    m.rows = [
      row({ id: id(1), name: 'Customer Acme payroll' }),
      row({ id: id(2), name: 'Customer Umbrella webhook', trigger: WEBHOOK, actions: SCRIPT_ACTION }),
      row({ id: id(3), name: 'Customer Wayne command', actions: COMMAND }),
      row({ id: id(4), name: 'Customer Stark notice', actions: UNCONVERTIBLE }),
    ];
    m.policyRows = [policyRow(1)];
    const c = await conversionCensus(NOW);
    // The form-shaped row's recognition carries its name in `values`; only `.formShaped` may be read.
    expect(m.recognize).toHaveBeenCalled();
    const text = JSON.stringify(c);
    for (const needle of ['Acme', 'Umbrella', 'Wayne', 'Stark', 'Globex', 'Initech', 'CustomerSecretCommand', 'Moved from Job']) {
      expect(text).not.toContain(needle);
    }
    for (const [path, value] of leaves(c)) expect(value === null || typeof value === 'number', path).toBe(true);
  });

  it('a row whose context cannot load is counted, not thrown', async () => {
    m.rows = [row({ id: id(1) })];
    m.context.mockRejectedValueOnce(new Error('no owner'));
    const c = await conversionCensus(NOW);
    expect(c.contextErrors).toBe(1);
  });
});
