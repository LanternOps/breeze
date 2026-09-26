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
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

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
  buildCompiledTemplate,
  buildCompiledRule,
  buildCompiledAutomation,
  computeCompiledHash,
  verifyCompiled,
  compileMonitorInTx,
  NetworkMonitorAdoptionError,
} = await import('./monitorCompiler');

import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';
import { networkMonitorAlertRules, networkMonitors } from '../../db/schema/monitors';
import { discoveredAssets } from '../../db/schema/discovery';
import { networkCheckKind } from './kinds/networkCheck';
import { getTenantExportPolicyRegistry } from '../tenantExportPolicyRegistry';

describe('W05e retirement columns', () => {
  it('network_monitors and network_monitor_alert_rules carry retired_at / retired_reason', () => {
    expect(networkMonitors.retiredAt.name).toBe('retired_at');
    expect(networkMonitors.retiredReason.name).toBe('retired_reason');
    expect(networkMonitorAlertRules.retiredAt.name).toBe('retired_at');
    expect(networkMonitorAlertRules.retiredReason.name).toBe('retired_reason');
  });

  it('includes network monitor retirement metadata in tenant exports', () => {
    const columns = getTenantExportPolicyRegistry().network_monitors?.columns;
    expect(columns?.retired_at?.decision).toBe('include');
    expect(columns?.retired_reason?.decision).toBe('include');
  });
});

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
function makeTx(existingByTable: Record<string, string | undefined> = {}, adoptable: string | null = null, siteId: string | null = null) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  let selectIdx = 0;
  const selectOrder: string[] = [];

  const tx: any = {
    _inserts: inserts,
    _updates: updates,
    _selectOrder: selectOrder,
    _adoptionWhere: null as SQL | null,
    select: () => {
      const table = ['alertTemplates', 'alertRules', 'automations', 'networkMonitors'][selectIdx];
      selectIdx++;
      selectOrder.push(table ?? 'unknown');
      const existing = table ? existingByTable[table] : undefined;
      return {
        from: (source: unknown) => ({
          where: () => ({ limit: async () => {
            if (source === discoveredAssets) {
              selectIdx--;
              selectOrder.pop();
              return [{ siteId }];
            }
            return existing ? [{ id: existing }] : [];
          } }),
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
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: SQL) => {
          const adoption = table === networkMonitors && Object.keys(values).length === 1 && 'managedByMonitorId' in values;
          if (adoption) tx._adoptionWhere = predicate;
          const apply = () => { updates.push({ id: adoption ? adoptable ?? 'missing' : 'existing', values }); };
          return {
            returning: async () => {
              apply();
              return adoption ? (adoptable ? [{ id: adoptable }] : []) : [{ id: 'existing' }];
            },
            then: (resolve: (value: undefined) => unknown) => {
              apply();
              return Promise.resolve(undefined).then(resolve);
            },
          };
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
      assetId: null,
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
      expectedConfig: { expectedStatus: 301, followRedirects: true }, // explicit override wins
    },
    {
      label: 'http_check with a 2xx expectStatus but followRedirects explicitly false',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 200, followRedirects: false, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 200, followRedirects: false },
    },
    {
      label: 'http_check with followRedirects explicitly false and expectStatus omitted',
      condition: { checkType: 'http_check', target: 'https://example.com', followRedirects: false, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { followRedirects: false }, // explicit false wins even with no 3xx expectation in play
    },
    {
      // Lower boundary of the 3xx range: 300 itself must trip the implicit default.
      label: 'http_check with expectStatus at the 3xx lower boundary (300)',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 300, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 300, followRedirects: false },
    },
    {
      // Upper boundary of the 3xx range: 399 itself must trip the implicit default.
      label: 'http_check with expectStatus at the 3xx upper boundary (399)',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 399, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 399, followRedirects: false },
    },
    {
      // Just outside the range on either side: neither should trip the default.
      label: 'http_check with expectStatus just below the 3xx range (299)',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 299, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 299 },
    },
    {
      label: 'http_check with expectStatus just above the 3xx range (400)',
      condition: { checkType: 'http_check', target: 'https://example.com', expectStatus: 400, pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      expectedConfig: { expectedStatus: 400 },
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
    expect(row.config).toEqual({
      ...(condition.checkType === 'http_check' ? { url: condition.target } : {}),
      ...(condition.checkType === 'dns_check' ? { hostname: condition.target } : {}),
      ...expectedConfig,
      ...('followRedirects' in condition && condition.followRedirects === true ? { followRedirects: true } : {}),
    });
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

  /**
   * #6510: `followRedirects` is the new key this PR introduces, and its
   * entire purpose is to reach the agent's `GetPayloadBool(payload,
   * "followRedirects", true)` read — the exact same "does the compiled key
   * survive the verbatim `buildMonitorCommand` spread" question #6352 was
   * about, just for a different field. Assert it explicitly rather than
   * trusting the `expectedStatus` case above to stand in for it.
   */
  it('the compiled http_check followRedirects:false key survives buildMonitorCommand into the agent payload', async () => {
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
    expect(command.payload.followRedirects).toBe(false);
  });

  it('adopts in place using the existing row id', async () => {
    const tx = makeTx({ networkMonitors: 'legacy-row-1' }, 'legacy-row-1');
    await compileMonitorInTx(tx, makeDef(), { adoptNetworkMonitorId: 'legacy-row-1' });
    expect(tx._updates).toContainEqual({ id: 'legacy-row-1', values: { managedByMonitorId: makeDef().id } });
    expect(tx._inserts.filter((row: Record<string, unknown>) => 'monitorType' in row)).toHaveLength(0);
    const networkUpdates = tx._updates.filter((row: { values: Record<string, unknown> }) => 'monitorType' in row.values);
    expect(networkUpdates).toHaveLength(1);
    expect(networkUpdates[0].values).toMatchObject({ assetId: null, siteId: null });
    expect(Object.keys(networkUpdates[0].values).some(key => key.startsWith('tls'))).toBe(false);
  });

  it('rejects a row the conditional adoption update cannot acquire', async () => {
    await expect(compileMonitorInTx(makeTx({}, null), makeDef(), { adoptNetworkMonitorId: 'legacy-row-1' }))
      .rejects.toBeInstanceOf(NetworkMonitorAdoptionError);
  });

  it.each([makeDef().orgId, null])('guards adoption by row id, unmanaged/unretired state and org (%s)', async (orgId) => {
    const tx = makeTx({}, null);
    await compileMonitorInTx(tx, makeDef({ orgId }), { adoptNetworkMonitorId: 'legacy-row-1' }).catch(() => undefined);
    expect(tx._adoptionWhere).not.toBeNull();
    const query = new PgDialect().sqlToQuery(tx._adoptionWhere);
    expect(query.sql).toContain('"network_monitors"."id" =');
    expect(query.sql).toContain('"network_monitors"."managed_by_monitor_id" is null');
    expect(query.sql).toContain('"network_monitors"."retired_at" is null');
    if (orgId) {
      expect(query.sql).toContain('"network_monitors"."org_id" =');
      expect(query.params).toEqual(['legacy-row-1', orgId]);
    } else {
      expect(query.sql).toContain('and false');
      expect(query.params).toEqual(['legacy-row-1']);
    }
    expect(tx._inserts.some((row: Record<string, unknown>) => 'monitorType' in row)).toBe(false);
  });

  it('adopts with the bound asset’s current site', async () => {
    const tx = makeTx({ networkMonitors: 'legacy-row-1' }, 'legacy-row-1', 'site-current');
    await compileMonitorInTx(tx, makeDef({ condition: { checkType: 'icmp_ping', target: 'host', assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }), {
      adoptNetworkMonitorId: 'legacy-row-1',
    });
    expect(tx._updates.find((row: { values: Record<string, unknown> }) => 'monitorType' in row.values)?.values)
      .toMatchObject({ assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', siteId: 'site-current' });
    expect(tx._updates).toContainEqual({ id: 'legacy-row-1', values: { managedByMonitorId: makeDef().id } });
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


describe('network_check widening', () => {
  const assetId = 'a0000000-0000-4000-8000-0000000000aa';

  it.each([
    [{ checkType: 'http_check', target: 'https://example.com', assetId, expectStatus: 204, method: 'HEAD', expectedBody: 'ok', headers: { Accept: 'text/plain' }, verifySsl: false, followRedirects: true }, { url: 'https://example.com', expectedStatus: 204, method: 'HEAD', expectedBody: 'ok', headers: { Accept: 'text/plain' }, verifySsl: false, followRedirects: true }],
    [{ checkType: 'tcp_port', target: 'host', port: 22, expectBanner: 'SSH' }, { port: 22, expectBanner: 'SSH' }],
    [{ checkType: 'icmp_ping', target: 'host', count: 4, packetSize: 64 }, { count: 4, packetSize: 64 }],
    [{ checkType: 'dns_check', target: 'example.com', recordType: 'MX', expectedValue: 'mail.example.com', nameserver: 'resolver.example.com' }, { hostname: 'example.com', recordType: 'MX', expectedValue: 'mail.example.com', nameserver: 'resolver.example.com' }],
  ])('preserves per-type configuration and binding %j', (condition, config) => {
    const row = buildCompiledNetworkMonitor(makeDef({ condition }));
    expect(row.config).toEqual(config);
    expect(row.assetId).toBe('assetId' in condition ? assetId : null);
  });

  it.each([false, true])('writes the current asset site on compile (existing=%s)', async (existing) => {
    const tx = makeTx(existing ? { networkMonitors: 'nm-1' } : {}, null, 'site-current');
    await compileMonitorInTx(tx, makeDef({ condition: { checkType: 'icmp_ping', target: 'host', assetId } }));
    const rows = [...tx._inserts, ...tx._updates.map((u: { values: Record<string, unknown> }) => u.values)];
    expect(rows.find(row => row.monitorType)).toMatchObject({ assetId, siteId: 'site-current' });
  });

  it('explicitly clears the site when unbinding', async () => {
    const tx = makeTx({ networkMonitors: 'nm-1' });
    await compileMonitorInTx(tx, makeDef());
    expect(tx._updates.find((u: { values: Record<string, unknown> }) => u.values.monitorType)?.values).toMatchObject({ assetId: null, siteId: null });
  });

  it.each([null, 'site-current'])('verifies the site using the supplied executor (%s)', async (siteId) => {
    const def = makeDef({ condition: { checkType: 'icmp_ping', target: 'host', ...(siteId ? { assetId } : {}) } });
    def.compiledHash = computeCompiledHash(def);
    const check = { ...buildCompiledNetworkMonitor(def), siteId };
    const rows = [
      { ...buildCompiledTemplate(def), id: 't-1' },
      { ...buildCompiledRule(def, 't-1'), id: 'r-1' },
      { ...buildCompiledAutomation(def, 'r-1'), id: 'a-1' },
      check,
      { siteId },
    ];
    const executor = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [rows.shift()] }) }) }),
    };
    expect(await verifyCompiled(def, executor as never)).toEqual({ inSync: true, diff: [] });
    check.siteId = 'stale-site';
    rows.length = 0;
    rows.push(
      { ...buildCompiledTemplate(def), id: 't-1' },
      { ...buildCompiledRule(def, 't-1'), id: 'r-1' },
      { ...buildCompiledAutomation(def, 'r-1'), id: 'a-1' },
      check,
      { siteId },
    );
    const verification = await verifyCompiled(def, executor as never);
    expect(verification.inSync).toBe(false);
    expect(verification.diff.some(diff => diff.startsWith('network_monitors.siteId:'))).toBe(true);
  });

  it('carries verdict overrides without making asset binding overridable', () => {
    const condition = networkCheckKind.conditionSchema.parse({ checkType: 'icmp_ping', target: 'host', degradedIsFailure: true, maxResponseMs: 800 });
    expect(networkCheckKind.toAlertCondition(condition, { monitorId: 'monitor' })).toMatchObject({ degradedIsFailure: true, maxResponseMs: 800 });
    expect(networkCheckKind.overridableKeys).toEqual(['pollingIntervalSeconds', 'consecutiveFailures', 'degradedIsFailure', 'maxResponseMs']);
  });
});
