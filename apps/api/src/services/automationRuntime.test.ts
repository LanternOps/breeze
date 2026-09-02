import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3409 PR2 Task 4: executeRunScriptAction touches `db` (a conditional
// scriptExecutions status update) and dispatches through the mocked seams
// below. Every other exported function in this file is pure and unaffected
// by these mocks. Mirrors the mock shape used in scriptExecution.test.ts.
vi.mock('../db', () => ({
  db: { update: vi.fn() },
}));
vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn().mockResolvedValue({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: true,
    deliveryOutcome: 'sent',
    executedAt: new Date('2026-08-11T00:00:00Z'),
    ignoredParameters: [],
  }),
}));
// See scriptExecution.test.ts for why the resolver itself is stubbed here
// rather than exercised for real — its own coverage lives in
// tenantVariableResolution.test.ts.
vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));

import {
  AutomationValidationError,
  executeRunScriptAction,
  isCronDue,
  loadAutomationRunVariableScope,
  normalizeAutomationActions,
  normalizeAutomationTrigger,
  normalizeNotificationTargets,
  withWebhookDefaults,
} from './automationRuntime';
import { dispatchScriptToDevice } from './scriptDispatch';
import { loadTenantVariableScope } from './tenantVariableResolution';

describe('automationRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      delivered: true,
      deliveryOutcome: 'sent',
      executedAt: new Date('2026-08-11T00:00:00Z'),
      ignoredParameters: [],
    } as any);
    vi.mocked(loadTenantVariableScope).mockResolvedValue({ orgIds: new Set() } as any);
  });

  it('normalizes schedule trigger and evaluates due cron slots', () => {
    const trigger = normalizeAutomationTrigger({
      type: 'schedule',
      cronExpression: '30 14 * * *',
      timezone: 'UTC',
    });

    expect(trigger.type).toBe('schedule');
    expect(isCronDue('30 14 * * *', 'UTC', new Date('2026-01-01T14:30:00Z'))).toBe(true);
    expect(isCronDue('30 14 * * *', 'UTC', new Date('2026-01-01T14:31:00Z'))).toBe(false);
  });

  it('normalizes event trigger with filter', () => {
    const trigger = normalizeAutomationTrigger({
      type: 'event',
      eventType: 'device.offline',
      filter: { 'device.siteId': 'site-1' },
    });

    expect(trigger).toEqual({
      type: 'event',
      eventType: 'device.offline',
      filter: { 'device.siteId': 'site-1' },
    });
  });

  it('adds webhook defaults when secret and url are missing', () => {
    const base = normalizeAutomationTrigger({ type: 'webhook' });
    const trigger = withWebhookDefaults(base, 'automation-123', 'https://api.example.com/api/v1/automations');

    expect(trigger.type).toBe('webhook');
    if (trigger.type !== 'webhook') {
      throw new Error('expected webhook trigger');
    }
    expect(trigger.webhookUrl).toBe('https://api.example.com/api/v1/automations/webhooks/automation-123');
    expect(trigger.secret).toBeTruthy();
  });

  it('normalizes all supported action types', () => {
    const actions = normalizeAutomationActions([
      { type: 'run_script', scriptId: 'script-1' },
      { type: 'send_notification', notificationChannelId: 'channel-1' },
      { type: 'create_alert', alertSeverity: 'high', alertMessage: 'Disk low' },
      { type: 'execute_command', command: 'echo ok' },
    ]);

    expect(actions.map((action) => action.type)).toEqual([
      'run_script',
      'send_notification',
      'create_alert',
      'execute_command',
    ]);
  });

  it('normalizes an ai_triage action (wave 3d #3824)', () => {
    expect(normalizeAutomationActions([{ type: 'ai_triage' }]))
      .toEqual([{ type: 'ai_triage' }]);
  });

  it('normalizes a run_script action carrying string/number/boolean parameters (#3409 PR2 Task 7)', () => {
    const actions = normalizeAutomationActions([
      { type: 'run_script', scriptId: 'script-1', parameters: { s: 'a', n: 3, b: true } },
    ]);

    expect(actions).toEqual([
      { type: 'run_script', scriptId: 'script-1', parameters: { s: 'a', n: 3, b: true }, runAs: undefined },
    ]);
  });

  it('rejects a run_script action whose parameters fail the shared script-parameter schema', () => {
    expect(() =>
      normalizeAutomationActions([
        { type: 'run_script', scriptId: 'script-1', parameters: { nested: { bad: true } } },
      ])
    ).toThrow(AutomationValidationError);
  });

  it('rejects a run_script parameter key the agent could not turn into an env var name', () => {
    expect(() =>
      normalizeAutomationActions([
        { type: 'run_script', scriptId: 'script-1', parameters: { 'has space': 'v' } },
      ])
    ).toThrow(/actions\[0\]/);
  });

  it('leaves parameters undefined when the action omits them', () => {
    const actions = normalizeAutomationActions([{ type: 'run_script', scriptId: 'script-1' }]);
    expect(actions[0]).toMatchObject({ parameters: undefined });
  });

  // Content MUST carry a {{var.*}} token — the preload is gated on it, so a
  // token-free fixture would pass with the gate wired to constant false.
  const TOKEN_SCRIPT = {
    id: 'script-1',
    orgId: 'org-a',
    osTypes: ['linux'],
    runAs: 'system',
    content: 'curl {{var.repo_url}}',
  } as any;

  const contextFor = (deviceId: string, orgId: string, variableScope: unknown) => ({
    automation: { id: 'auto-1', orgId: 'org-a', name: 'Test automation', createdBy: 'user-1' },
    runId: 'run-1',
    device: {
      id: deviceId, orgId, hostname: `host-${deviceId}`, displayName: null,
      osType: 'linux' as const, status: 'online' as const, agentId: `agent-${deviceId}`,
      siteId: `site-${orgId}`, customFields: { owner: 'ops' },
    },
    scriptsById: new Map([['script-1', TOKEN_SCRIPT]]),
    channelsById: new Map(),
    variableScope,
  }) as any;

  it('takes the variable scope from the run context and never loads one itself (#3409 PR3 P2)', async () => {
    // The hoist's whole point: executeRunScriptAction runs once PER DEVICE PER
    // run_script action inside runWithConcurrency. Calling it N times must
    // therefore issue ZERO scope loads — the run-level preload already ran.
    const scope = { orgIds: new Set(['org-a']) };

    for (const deviceId of ['device-1', 'device-2', 'device-3']) {
      const result = await executeRunScriptAction(
        { type: 'run_script', scriptId: 'script-1' },
        0,
        contextFor(deviceId, 'org-a', scope),
      );
      expect(result.outcome.status).toBe('delivered');
    }

    expect(loadTenantVariableScope).not.toHaveBeenCalled();
    const calls = vi.mocked(dispatchScriptToDevice).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [args] of calls) {
      expect(args.variableScope).toBe(scope);
    }
  });

  it('carries the widened device projection through to dispatch (#3409 PR3 P3)', async () => {
    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      contextFor('device-1', 'org-a', { orgIds: new Set(['org-a']) }),
    );

    const dispatchArgs = vi.mocked(dispatchScriptToDevice).mock.calls[0]![0];
    expect(dispatchArgs.device).toMatchObject({
      hostname: 'host-device-1',
      siteId: 'site-org-a',
      customFields: { owner: 'ops' },
    });
  });

  // #3409 PR3 §2.2: an automation whose action configures a value for a
  // parameter that is BOUND to a source has that value dropped. Automations
  // have no parameter-capture UI, so the run log is the ONLY surface where an
  // author can ever see it — without this the ignore is completely silent for
  // exactly the consumer the "ignore, don't 400" decision was made for.
  it('records ignored bound parameter keys on the run log', async () => {
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      delivered: true,
      deliveryOutcome: 'sent',
      executedAt: new Date('2026-08-11T00:00:00Z'),
      ignoredParameters: ['api_key'],
    } as any);

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1', parameters: { api_key: 'configured-in-the-automation' } },
      0,
      contextFor('device-1', 'org-a', { orgIds: new Set(['org-a']) }),
    );

    expect(result.outcome.status).toBe('delivered');
    expect(result.log.details).toMatchObject({ ignoredParameterKeys: ['api_key'] });
    // KEYS ONLY — the configured value must not be copied into the run log.
    expect(JSON.stringify(result.log.details)).not.toContain('configured-in-the-automation');
  });

  it('leaves the run log untouched when nothing was ignored', async () => {
    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      contextFor('device-1', 'org-a', { orgIds: new Set(['org-a']) }),
    );

    expect(result.outcome.status).toBe('delivered');
    expect(result.log.details).not.toHaveProperty('ignoredParameterKeys');
  });

  describe('loadAutomationRunVariableScope (#3409 PR3 P2)', () => {
    const scriptsById = new Map<string, any>([
      ['script-1', TOKEN_SCRIPT],
      ['script-plain', { id: 'script-plain', content: 'echo hi' } as any],
    ]);

    it('loads ONCE for the run over the distinct org set, not once per device', async () => {
      const scope = { orgIds: new Set(['org-a', 'org-b']) };
      vi.mocked(loadTenantVariableScope).mockResolvedValue(scope as any);

      // Five devices, two orgs, two run_script actions — one call, two orgs.
      const result = await loadAutomationRunVariableScope(
        [
          { type: 'run_script', scriptId: 'script-1' },
          { type: 'run_script', scriptId: 'script-plain' },
        ] as any,
        scriptsById,
        ['org-a', 'org-b', 'org-a', 'org-b', 'org-a'],
      );

      expect(result).toBe(scope);
      expect(loadTenantVariableScope).toHaveBeenCalledTimes(1);
      expect(loadTenantVariableScope).toHaveBeenCalledWith(['org-a', 'org-b']);
    });

    it('passes the empty org list when no run_script action uses a {{var.*}} token', async () => {
      await loadAutomationRunVariableScope(
        [
          { type: 'run_script', scriptId: 'script-plain' },
          { type: 'execute_command', command: 'echo {{var.not_a_script}}' },
        ] as any,
        scriptsById,
        ['org-a', 'org-b'],
      );

      // [] is loadTenantVariableScope's documented no-op path — it
      // short-circuits before touching the DB.
      expect(loadTenantVariableScope).toHaveBeenCalledWith([]);
    });

    it('loads when ANY run_script action in the set uses a token, not only the first', async () => {
      await loadAutomationRunVariableScope(
        [
          { type: 'run_script', scriptId: 'script-plain' },
          { type: 'run_script', scriptId: 'script-1' },
        ] as any,
        scriptsById,
        ['org-a'],
      );

      expect(loadTenantVariableScope).toHaveBeenCalledWith(['org-a']);
    });

    // #3409 PR3 P1. The fixture below is deliberately TOKEN-FREE so the
    // assertion is not vacuous: under the old content-only gate this run
    // passes `[]`, and every bound parameter then resolves against an empty
    // scope at dispatch.
    //
    // MUTATION-VERIFIED: forcing `scriptNeedsVariableScope` to `false` fails
    // this test (and the two sibling gate tests) and nothing else.
    it('loads a scope for a token-free script whose PARAMETERS bind a tenant variable', async () => {
      const boundScript = {
        id: 'script-bound',
        content: 'echo hi',
        parameters: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' }],
      } as any;

      await loadAutomationRunVariableScope(
        [{ type: 'run_script', scriptId: 'script-bound' }] as any,
        new Map([['script-bound', boundScript]]),
        ['org-a'],
      );

      expect(loadTenantVariableScope).toHaveBeenCalledWith(['org-a']);
    });

    it('does not load a scope for a token-free script whose parameters are all runtime', async () => {
      const runtimeScript = {
        id: 'script-runtime',
        content: 'echo hi',
        parameters: [{ name: 'level', type: 'string', source: 'runtime' }],
      } as any;

      await loadAutomationRunVariableScope(
        [{ type: 'run_script', scriptId: 'script-runtime' }] as any,
        new Map([['script-runtime', runtimeScript]]),
        ['org-a'],
      );

      expect(loadTenantVariableScope).toHaveBeenCalledWith([]);
    });

    it('does not throw when an action references a script that failed to load', async () => {
      await loadAutomationRunVariableScope(
        [{ type: 'run_script', scriptId: 'deleted-script' }] as any,
        scriptsById,
        ['org-a'],
      );

      expect(loadTenantVariableScope).toHaveBeenCalledWith([]);
    });
  });

  it('normalizes notification targets from legacy and canonical payloads', () => {
    expect(normalizeNotificationTargets(['channel-1', 'channel-2'])).toEqual({
      channelIds: ['channel-1', 'channel-2'],
    });

    expect(normalizeNotificationTargets({ channelIds: ['channel-1'], emails: ['ops@example.com'] })).toEqual({
      channelIds: ['channel-1'],
      emails: ['ops@example.com'],
    });
  });
});
