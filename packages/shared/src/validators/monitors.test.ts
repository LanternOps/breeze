import { describe, it, expect } from 'vitest';
import {
  createMonitorDefinitionSchema,
  updateMonitorDefinitionSchema,
  monitorConditionSchemas,
  monitorsInlineSettingsSchema,
  MONITOR_KINDS,
  SERVER_EVALUATED_MONITOR_KINDS,
  compositeConditionSchema,
  RECOVERY_CONDITION_KINDS,
  isLegacyRecoveryCondition,
  recoveryConditionProblem,
} from './monitors';
import { automationActionSchema, automationTriggerSchema } from './index';

describe('monitor definition validators (#5289)', () => {
  it('lists the W02 kinds, then the W04 coverage kinds', () => {
    expect(MONITOR_KINDS).toEqual([
      'cpu',
      'memory',
      'disk',
      'offline',
      'event_log',
      'patch_compliance',
      'service',
      'process',
      'process_resource',
      'cert_expiry',
      'bandwidth',
      'disk_io',
      'network_errors',
      'antivirus',
      'software_presence',
      'backup_continuity',
      'script',
      'network_check',
      'composite',
      'hardware_health',
      'time_sync',
      'container_image_currency',
    ]);
  });

  it('accepts a cpu monitor with a threshold condition and rejects an unknown condition key', () => {
    const ok = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'High CPU',
      kind: 'cpu',
      severity: 'high',
      condition: { operator: 'gt', value: 90, durationMinutes: 10 },
      responses: [],
    });
    expect(ok.success).toBe(true);
    const bad = monitorConditionSchemas.cpu.safeParse({ operator: 'gt', value: 90, metric: 'ramPercent' });
    expect(bad.success).toBe(false);
  });

  it('rejects a condition that does not match the kind', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'Mismatched',
      kind: 'cert_expiry',
      severity: 'low',
      condition: { operator: 'gt', value: 90 },
      responses: [],
    });
    expect(r.success).toBe(false);
  });

  it('requires recurrence threshold and window together', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
      responses: [],
      recurrenceThreshold: 3,
    });
    expect(r.success).toBe(false);
  });

  it('requires deliveryChannelIds when deliveryMode is channels', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
      deliveryMode: 'channels',
    });
    expect(r.success).toBe(false);
  });

  it('requires aiAgentId for an ai_triage response', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
      responses: [{ type: 'ai_triage' }],
    });
    expect(r.success).toBe(false);
  });

  it('update strips ownerScope', () => {
    const r = updateMonitorDefinitionSchema.safeParse({ ownerScope: 'partner', name: 'renamed' });
    expect(r.success).toBe(true);
    expect(r.success && 'ownerScope' in r.data).toBe(false);
  });

  it('update leaves an omitted key omitted, so a partial PATCH cannot reset stored config', () => {
    expect(updateMonitorDefinitionSchema.parse({ description: 'x' })).toStrictEqual({ description: 'x' });
    expect(updateMonitorDefinitionSchema.parse({})).toStrictEqual({});
    expect(updateMonitorDefinitionSchema.parse({ enabled: false })).toStrictEqual({ enabled: false });
  });

  it('create still fills its defaults', () => {
    const data = createMonitorDefinitionSchema.parse({
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
    });
    expect(data).toMatchObject({
      ownerScope: 'organization',
      enabled: true,
      responses: [],
      deliveryMode: 'inherit',
      deliveryChannelIds: [],
      recurrenceActions: [],
      pauseResponsesOnEscalation: true,
    });
  });

  // The service re-checks the merged definition, and only it can see the stored
  // channels this PATCH keeps.
  it('update accepts deliveryMode channels when deliveryChannelIds is omitted', () => {
    expect(updateMonitorDefinitionSchema.parse({ deliveryMode: 'channels' })).toStrictEqual({
      deliveryMode: 'channels',
    });
  });

  it('update still rejects deliveryMode channels with an explicitly empty channel list', () => {
    const r = updateMonitorDefinitionSchema.safeParse({ deliveryMode: 'channels', deliveryChannelIds: [] });
    expect(r.success).toBe(false);
  });

  it('inline settings carry attachment items', () => {
    const r = monitorsInlineSettingsSchema.safeParse({
      items: [
        { monitorId: '6b1f2b3a-0000-4000-8000-000000000001', enabled: false, overrides: { value: 95 } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.items[0]!.enabled).toBe(false);
  });

  it('event trigger accepts filter', () => {
    const r = automationTriggerSchema.safeParse({
      type: 'event',
      event: 'alert.triggered',
      filter: { ruleId: 'abc' },
    });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { filter?: unknown }).filter).toEqual({ ruleId: 'abc' });
  });
});

/**
 * W04 coverage kinds (#5287 / #5291).
 *
 * Each case below rejects ONE specific malformation rather than `{}` — a
 * `.strict()` object rejects `{}` for every kind, which discriminates nothing.
 */
describe('W04 coverage condition schemas (#5291)', () => {
  it('lists the five W04 kinds after the W02 thirteen', () => {
    expect(MONITOR_KINDS.slice(13, 18)).toEqual([
      'antivirus',
      'software_presence',
      'backup_continuity',
      'script',
      'network_check',
    ]);
  });

  it('antivirus: definitions_stale requires staleAfterDays', () => {
    expect(monitorConditionSchemas.antivirus.safeParse({ check: 'definitions_stale', staleAfterDays: 7 }).success).toBe(true);
    expect(monitorConditionSchemas.antivirus.safeParse({ check: 'realtime_disabled' }).success).toBe(true);
    // The malformation: the stale check with no staleness window is unanswerable.
    expect(monitorConditionSchemas.antivirus.safeParse({ check: 'definitions_stale' }).success).toBe(false);
  });

  it('backup_continuity: completed_with_errors is a valid check with no extra fields (#5396)', () => {
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'completed_with_errors' }).success).toBe(true);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'completed' }).success).toBe(false);
  });

  it('software_presence: version_below requires a version', () => {
    expect(monitorConditionSchemas.software_presence.safeParse({ name: 'TeamViewer', presence: 'installed' }).success).toBe(true);
    expect(monitorConditionSchemas.software_presence.safeParse({ name: 'Java', presence: 'version_below', version: '10.2' }).success).toBe(true);
    expect(monitorConditionSchemas.software_presence.safeParse({ name: 'Java', presence: 'version_below' }).success).toBe(false);
  });

  it('backup_continuity: each check requires its own parameter', () => {
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'no_successful_backup', maxAgeHours: 26 }).success).toBe(true);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'consecutive_failures', failureCount: 3 }).success).toBe(true);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'no_successful_backup', failureCount: 3 }).success).toBe(false);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'consecutive_failures', maxAgeHours: 26 }).success).toBe(false);
  });

  it('script: scriptId must be a uuid and the interval floor holds', () => {
    const parsed = monitorConditionSchemas.script.parse({ scriptId: '11111111-2222-4333-8444-555555555555' });
    expect(parsed).toEqual({
      scriptId: '11111111-2222-4333-8444-555555555555',
      intervalMinutes: 60,
      timeoutSeconds: 300,
      breachOnNonZeroExit: true,
    });
    expect(monitorConditionSchemas.script.safeParse({ scriptId: 'not-a-uuid' }).success).toBe(false);
    // A 1-minute probe interval would hammer every attached device.
    expect(monitorConditionSchemas.script.safeParse({ scriptId: '11111111-2222-4333-8444-555555555555', intervalMinutes: 1 }).success).toBe(false);
  });

  it('network_check: tcp_port requires a port', () => {
    expect(monitorConditionSchemas.network_check.safeParse({ checkType: 'icmp_ping', target: '10.0.0.1' }).success).toBe(true);
    expect(monitorConditionSchemas.network_check.safeParse({ checkType: 'tcp_port', target: '10.0.0.1', port: 443 }).success).toBe(true);
    expect(monitorConditionSchemas.network_check.safeParse({ checkType: 'tcp_port', target: '10.0.0.1' }).success).toBe(false);
  });

  // #6510: followRedirects is an optional http_check override — the compiler
  // (not this schema) is what applies the smart default for a 3xx expectStatus.
  it('network_check: http_check accepts an explicit followRedirects boolean', () => {
    expect(
      monitorConditionSchemas.network_check.safeParse({
        checkType: 'http_check',
        target: 'https://example.com',
        expectStatus: 301,
        followRedirects: false,
      }).success,
    ).toBe(true);
    expect(
      monitorConditionSchemas.network_check.safeParse({
        checkType: 'http_check',
        target: 'https://example.com',
        followRedirects: true,
      }).success,
    ).toBe(true);
    expect(
      monitorConditionSchemas.network_check.safeParse({
        checkType: 'http_check',
        target: 'https://example.com',
        followRedirects: 'false',
      }).success,
    ).toBe(false);
  });

  it('a definition whose condition does not match its kind is rejected', () => {
    const result = createMonitorDefinitionSchema.safeParse({
      name: 'AV stale',
      kind: 'antivirus',
      severity: 'high',
      // A software_presence condition under the antivirus kind.
      condition: { name: 'TeamViewer', presence: 'installed' },
    });
    expect(result.success).toBe(false);
  });
});

describe('composite monitor kind (W05c1)', () => {
  it('is a registered kind whose children are restricted to server-evaluated kinds', () => {
    expect(MONITOR_KINDS).toContain('composite');
    expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain('composite');
    for (const agentKind of ['service', 'process', 'process_resource', 'script', 'network_check']) {
      expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain(agentKind);
    }
  });

  it('accepts 2..10 children, cross-validates each child against its kind schema, defaults match=all', () => {
    const ok = compositeConditionSchema.safeParse({
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'memory', condition: { operator: 'gt', value: 90, durationMinutes: 5 } },
      ],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.match).toBe('all');

    const one = compositeConditionSchema.safeParse({ match: 'any', children: [{ kind: 'cpu', condition: { operator: 'gt', value: 80 } }] });
    expect(one.success).toBe(false);

    const badChild = compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'disk', condition: { operator: 'gt', value: 101 } },
      ],
    });
    expect(badChild.success).toBe(false);
    expect(badChild.success ? '' : JSON.stringify(badChild.error.issues[0]?.path)).toBe('["children",1,"condition"]');

    const agentChild = compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'service', condition: { serviceName: 'spooler' } },
      ],
    });
    expect(agentChild.success).toBe(false);

    const nested = compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 80 } },
        { kind: 'composite', condition: { match: 'all', children: [] } },
      ],
    });
    expect(nested.success).toBe(false);
  });

  it('monitorConditionSchemas.composite is the same schema', () => {
    expect(monitorConditionSchemas.composite).toBe(compositeConditionSchema);
  });
});

describe('consecutiveFailures widened to 1..100 (W05c1, matches the watch domain)', () => {
  it.each(['service', 'process', 'network_check'] as const)('%s accepts 100 and rejects 101', (kind) => {
    const base =
      kind === 'service' ? { serviceName: 'x' } : kind === 'process' ? { processName: 'x' } : { checkType: 'icmp_ping', target: '10.0.0.1' };
    expect(monitorConditionSchemas[kind].safeParse({ ...base, consecutiveFailures: 100 }).success).toBe(true);
    expect(monitorConditionSchemas[kind].safeParse({ ...base, consecutiveFailures: 101 }).success).toBe(false);
  });
});

describe('monitors link inheritance (W05c1)', () => {
  it('defaults to cumulative and accepts replace', () => {
    expect(monitorsInlineSettingsSchema.parse({ items: [] }).inheritance).toBe('cumulative');
    expect(monitorsInlineSettingsSchema.parse({ items: [], inheritance: 'replace' }).inheritance).toBe('replace');
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], inheritance: 'closest' }).success).toBe(false);
  });
});

describe('execute_command restart parameters (W05c1, spec C9)', () => {
  it('accepts maxAttempts 0..50 and cooldownSeconds 30..86400, both optional', () => {
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'x' }).success).toBe(true);
    expect(
      automationActionSchema.safeParse({ type: 'execute_command', command: 'x', kind: 'restart_service', maxAttempts: 3, cooldownSeconds: 300 }).success,
    ).toBe(true);
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'x', maxAttempts: 51 }).success).toBe(false);
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'x', cooldownSeconds: 29 }).success).toBe(false);
  });
});

describe('monitors inline settings — checkIntervalSeconds (W05d)', () => {
  it('leaves the interval absent and accepts explicit 10..3600', () => {
    expect(monitorsInlineSettingsSchema.parse({ items: [] })).not.toHaveProperty('checkIntervalSeconds');
    expect(monitorsInlineSettingsSchema.parse({ items: [], checkIntervalSeconds: 10 }).checkIntervalSeconds).toBe(10);
    expect(monitorsInlineSettingsSchema.parse({ items: [], checkIntervalSeconds: 3600 }).checkIntervalSeconds).toBe(3600);
  });
  it('rejects out-of-range and non-integer values', () => {
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], checkIntervalSeconds: 9 }).success).toBe(false);
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], checkIntervalSeconds: 3601 }).success).toBe(false);
    expect(monitorsInlineSettingsSchema.safeParse({ items: [], checkIntervalSeconds: 60.5 }).success).toBe(false);
  });
});

describe('network_check condition (W05e widening)', () => {
  const schema = monitorConditionSchemas.network_check;
  const base = { checkType: 'icmp_ping', target: '10.0.0.1' };

  it('accepts an asset binding, HTTP options and legacy verdicts', () => {
    const condition = {
      checkType: 'http_check', target: 'https://example.com',
      assetId: '11111111-1111-4111-8111-111111111111',
      expectStatus: 204, method: 'HEAD', expectedBody: 'ok', headers: { Accept: 'text/plain' },
      verifySsl: false, followRedirects: true, degradedIsFailure: true, maxResponseMs: 800,
      pollingIntervalSeconds: 10, timeoutSeconds: 300, consecutiveFailures: 1,
    };
    expect(schema.parse(condition)).toEqual(condition);
  });

  it.each([
    { checkType: 'icmp_ping', count: 20, packetSize: 65535 },
    { checkType: 'tcp_port', port: 22, expectBanner: 'SSH' },
    { checkType: 'dns_check', recordType: 'MX', expectedValue: 'mail.example.com', nameserver: '1.1.1.1' },
  ])('preserves options for $checkType', (options) => {
    expect(schema.parse({ target: 'example.com', ...options })).toMatchObject(options);
  });

  it.each([
    { checkType: 'icmp_ping', expectBanner: 'SSH' },
    { checkType: 'tcp_port', port: 22, count: 1 },
    { checkType: 'http_check', recordType: 'A' },
    { checkType: 'dns_check', followRedirects: false },
  ])('rejects options belonging to another check type ($checkType)', (options) => {
    const result = schema.safeParse({ target: 'example.com', ...options });
    expect(result.success).toBe(false);
    if (!result.success) {
      const invalidKey = Object.keys(options).at(-1);
      expect(result.error.issues[0]?.path).toEqual([invalidKey]);
    }
  });

  it('keeps legacy interval, timeout and failure ranges', () => {
    expect(schema.safeParse({ ...base, pollingIntervalSeconds: 10, timeoutSeconds: 1, consecutiveFailures: 1 }).success).toBe(true);
    expect(schema.safeParse({ ...base, pollingIntervalSeconds: 86400, timeoutSeconds: 300, consecutiveFailures: 100 }).success).toBe(true);
  });

  it.each([
    { pollingIntervalSeconds: 9 }, { pollingIntervalSeconds: 86401 },
    { timeoutSeconds: 0 }, { timeoutSeconds: 301 },
    { consecutiveFailures: 0 }, { consecutiveFailures: 101 },
    { assetId: 'invalid' }, { maxResponseMs: 0 }, { maxResponseMs: 600001 },
    { count: 0 }, { count: 21 }, { packetSize: 15 }, { packetSize: 65536 },
  ])('rejects invalid boundary values %j', (values) => {
    expect(schema.safeParse({ ...base, ...values }).success).toBe(false);
  });

  it('defaults verdict and scheduling fields', () => {
    expect(schema.parse(base)).toEqual({
      ...base, degradedIsFailure: false, pollingIntervalSeconds: 60,
      timeoutSeconds: 5, consecutiveFailures: 2,
    });
  });
});

describe('monitor lifecycle overrides (alert re-arm W2, #10765)', () => {
  const base = { name: 'x', kind: 'offline', severity: 'high', condition: { durationMinutes: 15 } } as const;

  it('create without cooldownMinutes or autoResolve inherits: no default fills them', () => {
    const data = createMonitorDefinitionSchema.parse(base);
    expect(data.cooldownMinutes).toBeUndefined();
    expect(data.autoResolve).toBeUndefined();
    expect(data.rearmMode).toBeUndefined();
    expect(data.rearmDelayMinutes).toBeUndefined();
  });

  it('accepts null as an explicit inherit, and real values including 0 and false', () => {
    expect(createMonitorDefinitionSchema.parse({ ...base, cooldownMinutes: null, autoResolve: null }))
      .toMatchObject({ cooldownMinutes: null, autoResolve: null });
    expect(createMonitorDefinitionSchema.parse({ ...base, cooldownMinutes: 0, autoResolve: false }))
      .toMatchObject({ cooldownMinutes: 0, autoResolve: false });
  });

  it('update omitting cooldownMinutes leaves it omitted, and null is kept to mean inherit', () => {
    expect(updateMonitorDefinitionSchema.parse({ description: 'x' })).toStrictEqual({ description: 'x' });
    expect(updateMonitorDefinitionSchema.parse({ cooldownMinutes: null, autoResolve: null }))
      .toStrictEqual({ cooldownMinutes: null, autoResolve: null });
  });

  it('bounds cooldownMinutes to 0–1440', () => {
    expect(updateMonitorDefinitionSchema.safeParse({ cooldownMinutes: 1441 }).success).toBe(false);
    expect(updateMonitorDefinitionSchema.safeParse({ cooldownMinutes: -1 }).success).toBe(false);
  });

  it('after_delay requires minutes on create and update', () => {
    const create = createMonitorDefinitionSchema.safeParse({ ...base, rearmMode: 'after_delay' });
    expect(create.success).toBe(false);
    expect(create.error?.issues[0]?.path).toEqual(['rearmDelayMinutes']);
    expect(updateMonitorDefinitionSchema.safeParse({ rearmMode: 'after_delay' }).success).toBe(false);
    expect(updateMonitorDefinitionSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: 30 }).success).toBe(true);
  });

  it('rejects minutes on any other mode, and out-of-range minutes', () => {
    expect(createMonitorDefinitionSchema.safeParse({ ...base, rearmMode: 'new_evidence', rearmDelayMinutes: 30 }).success).toBe(false);
    expect(updateMonitorDefinitionSchema.safeParse({ rearmMode: null, rearmDelayMinutes: 30 }).success).toBe(false);
    expect(updateMonitorDefinitionSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: 0 }).success).toBe(false);
    expect(updateMonitorDefinitionSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: 1441 }).success).toBe(false);
  });

  it('leaves a delay-only patch to the service, which checks the merged row', () => {
    expect(updateMonitorDefinitionSchema.safeParse({ rearmDelayMinutes: 45 }).success).toBe(true);
  });
});

describe('monitor recovery condition (alert re-arm W3, #10765, #10935)', () => {
  const trigger = { category: 'application', level: 'warning', sourcePattern: 'APCPBEAgent', messagePattern: 'On Battery' };
  const recovery = { category: 'application', level: 'info', sourcePattern: 'APCPBEAgent', messagePattern: 'Power Restored', windowMinutes: 60 };
  const eventLog = { name: 'UPS on battery', kind: 'event_log', severity: 'high', condition: trigger } as const;
  const offline = { name: 'Down', kind: 'offline', severity: 'high', condition: { durationMinutes: 15 } } as const;
  // The exact shape #10935 reported: a group with no `logic`, which the engine
  // reads as a leaf with no type, so the alert can never auto-resolve.
  const groupWithoutLogic = { conditions: [{ type: 'event_log', category: 'application', level: 'info', countThreshold: 1, windowMinutes: 60 }] };
  const rawLeaf = { type: 'event_log', category: 'application', level: 'info', messagePattern: 'Power Restored', countThreshold: 1, windowMinutes: 60 };
  const rawGroup = { logic: 'or', conditions: [rawLeaf, { logic: 'and', conditions: [rawLeaf] }] };

  const issuePaths = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
    result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

  describe('event_log autoResolveConditions must parse as the event_log schema', () => {
    it('accepts a kind-shaped value, defaulting countThreshold to 1', () => {
      const parsed = createMonitorDefinitionSchema.safeParse({ ...eventLog, autoResolveConditions: recovery });
      expect(parsed.success).toBe(true);
      expect(monitorConditionSchemas.event_log.parse(recovery).countThreshold).toBe(1);
    });

    it('rejects a value that is not the event_log shape, at autoResolveConditions', () => {
      const bad = createMonitorDefinitionSchema.safeParse({ ...eventLog, autoResolveConditions: { category: 'nope', level: 'info' } });
      expect(bad.success).toBe(false);
      expect(issuePaths(bad)).toEqual(['autoResolveConditions']);
      expect(createMonitorDefinitionSchema.safeParse({ ...eventLog, autoResolveConditions: {} }).success).toBe(false);
    });

    it('null and omitted mean no recovery condition', () => {
      expect(createMonitorDefinitionSchema.safeParse({ ...eventLog, autoResolveConditions: null }).success).toBe(true);
      expect(createMonitorDefinitionSchema.safeParse(eventLog).success).toBe(true);
      expect(createMonitorDefinitionSchema.safeParse({ ...offline, autoResolveConditions: null }).success).toBe(true);
    });
  });

  it('rejects autoResolveConditions on kinds without a recovery schema', () => {
    const create = createMonitorDefinitionSchema.safeParse({ ...offline, autoResolveConditions: { durationMinutes: 5 } });
    expect(create.success).toBe(false);
    expect(issuePaths(create)).toEqual(['autoResolveConditions']);
    const update = updateMonitorDefinitionSchema.safeParse({ kind: 'offline', autoResolveConditions: recovery });
    expect(update.success).toBe(false);
    expect(issuePaths(update)).toEqual(['autoResolveConditions']);
  });

  describe('#10935: a group with no logic is refused', () => {
    it('on create', () => {
      const result = createMonitorDefinitionSchema.safeParse({ ...eventLog, autoResolveConditions: groupWithoutLogic });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toEqual(['autoResolveConditions']);
    });

    it('on update, with the kind in the patch', () => {
      const result = updateMonitorDefinitionSchema.safeParse({ kind: 'event_log', autoResolveConditions: groupWithoutLogic });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toEqual(['autoResolveConditions']);
    });

    it('on update, with no kind in the patch', () => {
      const result = updateMonitorDefinitionSchema.safeParse({ autoResolveConditions: groupWithoutLogic });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toEqual(['autoResolveConditions']);
    });

    it('nested inside an otherwise valid group', () => {
      const nested = { logic: 'and', conditions: [rawLeaf, groupWithoutLogic] };
      expect(updateMonitorDefinitionSchema.safeParse({ autoResolveConditions: nested }).success).toBe(false);
    });
  });

  describe('accepts an existing raw type-bearing blob on update (ND3)', () => {
    it('a leaf, unchanged, with or without the kind', () => {
      expect(updateMonitorDefinitionSchema.parse({ autoResolveConditions: rawLeaf }).autoResolveConditions).toEqual(rawLeaf);
      expect(updateMonitorDefinitionSchema.safeParse({ kind: 'event_log', autoResolveConditions: rawLeaf }).success).toBe(true);
    });

    it('on a kind with no recovery schema, because that row already exists', () => {
      const raw = { type: 'threshold', metric: 'cpuPercent', operator: 'lt', value: 50 };
      expect(updateMonitorDefinitionSchema.safeParse({ kind: 'cpu', autoResolveConditions: raw }).success).toBe(true);
    });

    it('a group that has logic, unchanged', () => {
      expect(updateMonitorDefinitionSchema.parse({ autoResolveConditions: rawGroup }).autoResolveConditions).toEqual(rawGroup);
    });

    it('refuses group look-alikes the engine could never evaluate', () => {
      for (const bad of [
        { logic: 'xor', conditions: [rawLeaf] },
        { logic: 'and' },
        { logic: 'and', conditions: [] },
        { logic: 'and', conditions: 'nope' },
        { type: '' },
        { type: 7 },
      ]) {
        expect(updateMonitorDefinitionSchema.safeParse({ autoResolveConditions: bad }).success, JSON.stringify(bad)).toBe(false);
      }
    });

    it('a new monitor cannot start out with a raw blob', () => {
      for (const raw of [rawLeaf, rawGroup]) {
        const result = createMonitorDefinitionSchema.safeParse({ ...eventLog, autoResolveConditions: raw });
        expect(result.success, JSON.stringify(raw)).toBe(false);
        expect(issuePaths(result)).toEqual(['autoResolveConditions']);
      }
    });
  });

  it('classifies a value for callers that hold the merged kind', () => {
    expect(recoveryConditionProblem('event_log', null, { allowLegacy: false })).toBeNull();
    expect(recoveryConditionProblem('event_log', recovery, { allowLegacy: false })).toBeNull();
    expect(recoveryConditionProblem('offline', recovery, { allowLegacy: true })).toMatch(/event_log/);
    expect(recoveryConditionProblem('event_log', groupWithoutLogic, { allowLegacy: true })).toMatch(/event_log/);
    expect(recoveryConditionProblem('event_log', rawLeaf, { allowLegacy: true })).toBeNull();
    expect(recoveryConditionProblem('event_log', rawLeaf, { allowLegacy: false })).toMatch(/event_log/);
    expect(isLegacyRecoveryCondition(rawGroup)).toBe(true);
    expect(isLegacyRecoveryCondition(recovery)).toBe(false);
    expect(RECOVERY_CONDITION_KINDS).toEqual(['event_log']);
  });
});
