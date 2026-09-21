/**
 * W04 compiler additions (#5287 / #5291).
 *
 * Two things land in the compiler this wave:
 *
 *  1. The DIAGNOSTIC-SCRIPT BINDING GUARD. Before W04 only a monitor's RESPONSE
 *     actions went through `resolveAutomationReferencesForOwner`. A `script`
 *     monitor's probe script went through nothing, so a partner-wide monitor
 *     could name an org-owned script and compile happily — then fail at 3am
 *     inside the dispatch worker for every org except the script's owner.
 *  2. The managed `network_monitors` row a `network_check` compiles to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveReferencesMock, replaceBindingsMock } = vi.hoisted(() => ({
  resolveReferencesMock: vi.fn(async () => ({})),
  replaceBindingsMock: vi.fn(async () => undefined),
}));

class FakeAuthorizationError extends Error {}

vi.mock('../automationRuntime', () => ({
  resolveAutomationReferencesForOwner: resolveReferencesMock,
  replaceAutomationResourceBindings: replaceBindingsMock,
  AutomationReferenceAuthorizationError: FakeAuthorizationError,
}));

const {
  buildCompiledNetworkMonitor,
  buildDiagnosticScriptReferences,
  compileMonitorInTx,
} = await import('./monitorCompiler');

import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';

const SCRIPT_ID = 'a0000000-0000-4000-8000-000000000001';

function makeDef(overrides: Partial<MonitorDefinitionRow> = {}): MonitorDefinitionRow {
  return {
    id: 'd0000000-0000-4000-8000-000000000001',
    orgId: 'o0000000-0000-4000-8000-000000000001',
    partnerId: null,
    name: 'Gateway reachable',
    description: null,
    kind: 'network_check',
    enabled: true,
    condition: { checkType: 'tcp_port', target: '10.0.0.1', port: 443, pollingIntervalSeconds: 120, timeoutSeconds: 5, consecutiveFailures: 3 },
    severity: 'high',
    cooldownMinutes: 30,
    autoResolve: true,
    autoResolveConditions: null,
    responses: [],
    deliveryMode: 'inherit',
    deliveryChannelIds: [],
    escalationPolicyId: null,
    recurrenceThreshold: null,
    recurrenceWindowHours: null,
    recurrenceActions: [],
    pauseResponsesOnEscalation: true,
    aiAgentId: null,
    compiledAlertTemplateId: null,
    compiledAlertRuleId: null,
    compiledAutomationId: null,
    compiledHash: null,
    compiledAt: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as MonitorDefinitionRow;
}

/**
 * A transaction stub that records every managed upsert. `upsertManaged` does a
 * read-then-write, so returning an existing row on the second compile is what
 * proves idempotence keeps the same row id.
 */
function makeTx(existingByTable: Record<string, string | undefined> = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  let selectIdx = 0;
  const selectOrder: string[] = [];

  const tx: any = {
    _inserts: inserts,
    _updates: updates,
    _selectOrder: selectOrder,
    select: () => {
      const table = ['alertTemplates', 'alertRules', 'automations', 'networkMonitors'][selectIdx];
      selectIdx++;
      selectOrder.push(table ?? 'unknown');
      const existing = table ? existingByTable[table] : undefined;
      return {
        from: () => ({
          where: () => ({ limit: async () => (existing ? [{ id: existing }] : []) }),
        }),
      };
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserts.push(values);
          return [{ id: `new-${inserts.length}` }];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const chain: any = {
            returning: async () => {
              updates.push({ id: 'existing', values });
              return [{ id: 'existing' }];
            },
          };
          // The final `update(monitorDefinitions).set(...).where(...)` has no
          // `.returning()`, so `where()` itself must be awaitable.
          chain.then = (resolve: any) => Promise.resolve(undefined).then(resolve);
          return chain;
        },
      }),
    }),
  };
  return tx;
}

describe('diagnostic-script binding guard (#5291 W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveReferencesMock.mockResolvedValue({} as never);
  });

  it('expresses a script monitor\'s probe script as a run_script reference', () => {
    const refs = buildDiagnosticScriptReferences(
      makeDef({ kind: 'script', condition: { scriptId: SCRIPT_ID, intervalMinutes: 60, timeoutSeconds: 300, breachOnNonZeroExit: true } } as never),
    );
    expect(refs).toEqual([{ type: 'run_script', scriptId: SCRIPT_ID, whenOffline: 'queue' }]);
  });

  it('adds no reference for any non-script kind', () => {
    expect(buildDiagnosticScriptReferences(makeDef())).toEqual([]);
  });

  it('puts the probe script through the OWNERSHIP resolution, not just the responses', async () => {
    const def = makeDef({
      kind: 'script',
      partnerId: 'p0000000-0000-4000-8000-000000000001',
      orgId: null,
      condition: { scriptId: SCRIPT_ID, intervalMinutes: 60, timeoutSeconds: 300, breachOnNonZeroExit: true },
    } as never);

    await compileMonitorInTx(makeTx(), def);

    expect(resolveReferencesMock).toHaveBeenCalledTimes(1);
    const actions = (resolveReferencesMock.mock.calls[0] as unknown as unknown[])[2] as Array<Record<string, unknown>>;
    expect(actions).toContainEqual({ type: 'run_script', scriptId: SCRIPT_ID, whenOffline: 'queue' });
  });

  it('REFUSES a partner-wide script monitor whose script the owner cannot reach', async () => {
    // This is the whole point: the failure has to happen at authoring time
    // (surfaced as a 400 by the route), not at 3am inside the dispatch worker
    // for every org except the one that owns the script.
    resolveReferencesMock.mockRejectedValueOnce(new FakeAuthorizationError('org-owned script'));
    const def = makeDef({
      kind: 'script',
      partnerId: 'p0000000-0000-4000-8000-000000000001',
      orgId: null,
      condition: { scriptId: SCRIPT_ID, intervalMinutes: 60, timeoutSeconds: 300, breachOnNonZeroExit: true },
    } as never);

    await expect(compileMonitorInTx(makeTx(), def)).rejects.toBeInstanceOf(FakeAuthorizationError);
  });
});

describe('network_check compiles to a managed network_monitors row (#5291 W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveReferencesMock.mockResolvedValue({} as never);
  });

  it('inherits the definition\'s ownership axes and reuses the monitor_type vocabulary', () => {
    const row = buildCompiledNetworkMonitor(makeDef());
    expect(row).toEqual({
      orgId: 'o0000000-0000-4000-8000-000000000001',
      partnerId: null,
      name: '[monitor] Gateway reachable',
      monitorType: 'tcp_port',
      target: '10.0.0.1',
      config: { port: 443 },
      pollingInterval: 120,
      timeout: 5,
      isActive: true,
      managedByMonitorId: 'd0000000-0000-4000-8000-000000000001',
    });
  });

  it('carries a partner-wide definition through as a partner-wide check', () => {
    const row = buildCompiledNetworkMonitor(
      makeDef({ orgId: null, partnerId: 'p0000000-0000-4000-8000-000000000001' } as never),
    );
    expect(row.orgId).toBeNull();
    expect(row.partnerId).toBe('p0000000-0000-4000-8000-000000000001');
  });

  it('a disabled definition compiles to an inactive check', () => {
    expect(buildCompiledNetworkMonitor(makeDef({ enabled: false } as never)).isActive).toBe(false);
  });

  /**
   * #6352: `buildMonitorCommand` (`services/monitorCommands.ts`) spreads
   * `network_monitors.config` verbatim into the agent command payload — no
   * translation layer exists there. So every key the compiler writes into
   * `config` for a given `checkType` MUST already be the exact key the
   * agent's handler for that check type reads
   * (`agent/internal/heartbeat/handlers_monitor.go`), even though the kind's
   * own condition schema (`packages/shared/src/validators/monitors.ts`,
   * `network_check`) uses a different name (`expectStatus`) for it. This
   * table pins that contract per checkType so a future compiled field can't
   * silently reintroduce the same mismatch.
   */
  it.each([
    {
      label: 'tcp_port',
      condition: { checkType: 'tcp_port', target: '10.0.0.1', port: 8080, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { port: 8080 }, // agent: tools.GetPayloadInt(payload, "port", 443)
    },
    {
      label: 'http_check with expectStatus set (2xx)',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 200, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 200 }, // agent: tools.GetPayloadInt(payload, "expectedStatus", 200)
    },
    {
      label: 'http_check with expectStatus omitted',
      condition: { checkType: 'http_check', target: 'https://example.com', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: {}, // expectStatus omitted -> agent falls back to its own default (200)
    },
    {
      // #6510: a 3xx expectation can never be observed while the agent follows
      // the redirect (default true) — it would evaluate the FINAL hop's status
      // instead. The compiler must turn `followRedirects` off by default
      // whenever `expectStatus` is itself a 3xx, or the check can never go
      // healthy.
      label: 'http_check with a 3xx expectStatus (redirect expectation)',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 301, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 301, followRedirects: false },
    },
    {
      label: 'http_check with a 3xx expectStatus but followRedirects explicitly true',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 301, followRedirects: true, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 301 }, // explicit true == agent's own default, no need to send it
    },
    {
      label: 'http_check with a 2xx expectStatus but followRedirects explicitly false',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 200, followRedirects: false, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 200, followRedirects: false },
    },
    {
      label: 'icmp_ping',
      condition: { checkType: 'icmp_ping', target: '10.0.0.2', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: {},
    },
    {
      label: 'dns_check',
      condition: { checkType: 'dns_check', target: 'example.com', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: {},
    },
  ])('compiles $label config keys to the agent payload keys it reads', ({ condition, expectedConfig }) => {
    const row = buildCompiledNetworkMonitor(makeDef({ condition } as never));
    expect(row.config).toEqual(expectedConfig);
  });

  /**
   * Closes the loop the table above stops short of: `buildCompiledNetworkMonitor`
   * only proves the compiler's OUTPUT object carries the right key. The actual
   * bug (#6352) was in what happens to that `config` object one layer further
   * downstream — `buildMonitorCommand` (`services/monitorCommands.ts`) spreads it
   * verbatim into the agent command payload. This drives a compiled row through
   * `buildMonitorCommand` too, so a regression in that spread (e.g. someone
   * renaming or filtering keys there) would fail here even if the compiler's
   * own output looked correct.
   */
  it('the compiled http_check config keys survive buildMonitorCommand into the agent payload', async () => {
    const { buildMonitorCommand } = await import('../monitorCommands');
    const row = buildCompiledNetworkMonitor(
      makeDef({
        condition: {
          checkType: 'http_check',
          target: 'https://example.com',
          expectStatus: 301,
          pollingIntervalSeconds: 60,
          timeoutSeconds: 5,
          consecutiveFailures: 2,
        },
      } as never),
    );
    const command = buildMonitorCommand({
      id: 'nm0000000-0000-4000-8000-000000000001',
      monitorType: row.monitorType,
      target: row.target,
      config: row.config,
      timeout: row.timeout as number,
    });
    expect(command.payload.expectedStatus).toBe(301);
    expect(command.payload).not.toHaveProperty('expectStatus');
  });

  it('INSERTS the managed row on a first compile', async () => {
    const tx = makeTx();
    await compileMonitorInTx(tx, makeDef());
    expect(tx._selectOrder).toEqual(['alertTemplates', 'alertRules', 'automations', 'networkMonitors']);
    expect(tx._inserts.some((v: Record<string, unknown>) => v.monitorType === 'tcp_port' && v.target === '10.0.0.1')).toBe(true);
  });

  it('UPDATES the same row on a recompile, so result history stays attached', async () => {
    const tx = makeTx({
      alertTemplates: 't-1',
      alertRules: 'r-1',
      automations: 'a-1',
      networkMonitors: 'nm-1',
    });
    await compileMonitorInTx(tx, makeDef());
    expect(tx._inserts).toHaveLength(0);
    expect(tx._updates.some((u: { values: Record<string, unknown> }) => u.values.monitorType === 'tcp_port')).toBe(true);
  });

  it('does NOT touch network_monitors for any other kind', async () => {
    const tx = makeTx();
    await compileMonitorInTx(
      tx,
      makeDef({ kind: 'disk', condition: { operator: 'gt', value: 80 } } as never),
    );
    expect(tx._selectOrder).toEqual(['alertTemplates', 'alertRules', 'automations']);
  });
});
