import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, state, tables } = vi.hoisted(() => {
  const tables = {
    devices: { id: 'devices.id', orgId: 'devices.orgId', hostname: 'devices.hostname', osType: 'devices.osType' },
    alertRules: {
      id: 'alertRules.ruleId',
      orgId: 'alertRules.orgId',
      templateId: 'alertRules.templateId',
      name: 'alertRules.ruleName',
      targetType: 'alertRules.ruleTargetType',
      targetId: 'alertRules.ruleTargetId',
      isActive: 'alertRules.ruleIsActive',
    },
    alertTemplates: {
      id: 'alertTemplates.templateIdValue',
      name: 'alertTemplates.templateName',
      category: 'alertTemplates.templateCategory',
      severity: 'alertTemplates.templateSeverity',
      isBuiltIn: 'alertTemplates.templateIsBuiltIn',
      cooldownMinutes: 'alertTemplates.templateCooldownMinutes',
    },
    alertCorrelations: {
      id: 'alert_correlations.id',
      parentAlertId: 'alert_correlations.parentAlertId',
      childAlertId: 'alert_correlations.childAlertId',
      correlationType: 'alert_correlations.correlationType',
      confidence: 'alert_correlations.confidence',
      metadata: 'alert_correlations.metadata',
      createdAt: 'alert_correlations.createdAt',
    },
    alertCorrelationMembers: {
      orgId: 'alertCorrelationMembers.orgId',
      groupId: 'alertCorrelationMembers.groupId',
      alertId: 'alertCorrelationMembers.alertId',
      role: 'alertCorrelationMembers.role',
      confidence: 'alertCorrelationMembers.confidence',
      evidence: 'alertCorrelationMembers.evidence',
      updatedAt: 'alertCorrelationMembers.updatedAt',
    },
    brainDeviceContext: {
      id: 'brainDeviceContext.id',
      orgId: 'brainDeviceContext.orgId',
      deviceId: 'brainDeviceContext.deviceId',
      contextType: 'brainDeviceContext.contextType',
      summary: 'brainDeviceContext.summary',
      details: 'brainDeviceContext.details',
      createdAt: 'brainDeviceContext.createdAt',
      resolvedAt: 'brainDeviceContext.resolvedAt',
    },
    deviceChangeLog: {
      id: 'deviceChangeLog.id',
      orgId: 'deviceChangeLog.orgId',
      deviceId: 'deviceChangeLog.deviceId',
      timestamp: 'deviceChangeLog.timestamp',
      changeType: 'deviceChangeLog.changeType',
      changeAction: 'deviceChangeLog.changeAction',
      subject: 'deviceChangeLog.subject',
    },
    deviceEventLogs: {
      id: 'deviceEventLogs.id',
      orgId: 'deviceEventLogs.orgId',
      deviceId: 'deviceEventLogs.deviceId',
      timestamp: 'deviceEventLogs.timestamp',
      level: 'deviceEventLogs.level',
      category: 'deviceEventLogs.category',
      source: 'deviceEventLogs.source',
      eventId: 'deviceEventLogs.eventId',
      message: 'deviceEventLogs.message',
    },
    agentLogs: {
      id: 'agentLogs.id',
      orgId: 'agentLogs.orgId',
      deviceId: 'agentLogs.deviceId',
      timestamp: 'agentLogs.timestamp',
      level: 'agentLogs.level',
      component: 'agentLogs.component',
      message: 'agentLogs.message',
    },
    metricRollups: {
      orgId: 'metricRollups.orgId',
      sourceTable: 'metricRollups.sourceTable',
      deviceId: 'metricRollups.deviceId',
      bucketSeconds: 'metricRollups.bucketSeconds',
      metricName: 'metricRollups.metricName',
      bucketStart: 'metricRollups.bucketStart',
      avgValue: 'metricRollups.avgValue',
      maxValue: 'metricRollups.maxValue',
    },
    logCorrelationRules: {
      id: 'logCorrelationRules.logRuleId',
      name: 'logCorrelationRules.logRuleName',
      pattern: 'logCorrelationRules.logRulePattern',
      severity: 'logCorrelationRules.logRuleSeverity',
    },
    logCorrelations: {
      id: 'logCorrelations.logCorrelationId',
      orgId: 'logCorrelations.orgId',
      ruleId: 'logCorrelations.logRuleId',
      pattern: 'logCorrelations.detectedPattern',
      firstSeen: 'logCorrelations.firstSeen',
      lastSeen: 'logCorrelations.lastSeen',
      occurrences: 'logCorrelations.occurrences',
      affectedDevices: 'logCorrelations.affectedDevices',
      sampleLogs: 'logCorrelations.sampleLogs',
      alertId: 'logCorrelations.alertId',
    },
    configPolicyAlertRules: {
      id: 'configPolicyAlertRules.configPolicyAlertRuleId',
      featureLinkId: 'configPolicyAlertRules.featureLinkId',
      name: 'configPolicyAlertRules.configPolicyAlertRuleName',
      severity: 'configPolicyAlertRules.configPolicyAlertSeverity',
      cooldownMinutes: 'configPolicyAlertRules.configPolicyAlertCooldownMinutes',
    },
    configPolicyFeatureLinks: {
      id: 'configPolicyFeatureLinks.featureLinkId',
      configPolicyId: 'configPolicyFeatureLinks.configurationPolicyId',
      featureType: 'configPolicyFeatureLinks.featureType',
    },
    configurationPolicies: {
      id: 'configurationPolicies.configurationPolicyId',
      orgId: 'configurationPolicies.orgId',
      name: 'configurationPolicies.configurationPolicyName',
      status: 'configurationPolicies.configurationPolicyStatus',
    },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    const left = row[columnKey(predicate.col)];
    if (predicate.op === 'eq') return left === predicate.val;
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(left);
    if (predicate.op === 'isNull') return left === null || left === undefined;
    if (predicate.op === 'gte') return new Date(left as any).getTime() >= new Date(predicate.val as any).getTime();
    if (predicate.op === 'lte') return new Date(left as any).getTime() <= new Date(predicate.val as any).getTime();
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    if (predicate.op === 'or') return (predicate.args ?? []).some((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = {
    devices: [] as Array<Record<string, any>>,
    alertRuleSources: [] as Array<Record<string, any>>,
    correlations: [] as Array<Record<string, any>>,
    memberEvidence: [] as Array<Record<string, any>>,
    configPolicySources: [] as Array<Record<string, any>>,
    context: [] as Array<Record<string, any>>,
    changes: [] as Array<Record<string, any>>,
    eventLogs: [] as Array<Record<string, any>>,
    agentLogs: [] as Array<Record<string, any>>,
    metricRollups: [] as Array<Record<string, any>>,
    linkedLogCorrelations: [] as Array<Record<string, any>>,
  };

  class SelectQuery {
    private predicate: Predicate;
    constructor(private table: unknown, private projection?: Record<string, unknown>) {}
    where(predicate: Predicate) { this.predicate = predicate; return this; }
    leftJoin() { return this; }
    innerJoin() { return this; }
    orderBy() { return this; }
    limit(limit: number) { return Promise.resolve(this.rows().slice(0, limit)); }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      return Promise.resolve(this.rows()).then(resolve, reject);
    }
    private rows() {
      const source = this.table === tables.devices
        ? state.devices
        : this.table === tables.alertRules
          ? state.alertRuleSources
          : this.table === tables.alertCorrelations
            ? state.correlations
            : this.table === tables.alertCorrelationMembers
              ? state.memberEvidence
              : this.table === tables.configPolicyAlertRules
                ? state.configPolicySources
                : this.table === tables.brainDeviceContext
                  ? state.context
                  : this.table === tables.logCorrelations
                    ? state.linkedLogCorrelations
                    : this.table === tables.deviceChangeLog
                      ? state.changes
                      : this.table === tables.deviceEventLogs
                        ? state.eventLogs
                        : this.table === tables.agentLogs
                          ? state.agentLogs
                          : state.metricRollups;
      const filtered = source.filter((row) => evalPredicate(row, this.predicate));
      if (!this.projection) return filtered;
      return filtered.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(this.projection!)) {
          out[key] = row[columnKey(this.projection![key])];
        }
        return out;
      });
    }
  }

  const dbMock = {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: (table: unknown) => new SelectQuery(table, projection),
    })),
  };

  return { dbMock, state, tables };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
}));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  agentLogs: tables.agentLogs,
  alertCorrelationMembers: tables.alertCorrelationMembers,
  alertCorrelations: tables.alertCorrelations,
  alertRules: tables.alertRules,
  alertTemplates: tables.alertTemplates,
  brainDeviceContext: tables.brainDeviceContext,
  configPolicyAlertRules: tables.configPolicyAlertRules,
  configPolicyFeatureLinks: tables.configPolicyFeatureLinks,
  configurationPolicies: tables.configurationPolicies,
  deviceChangeLog: tables.deviceChangeLog,
  deviceEventLogs: tables.deviceEventLogs,
  devices: tables.devices,
  logCorrelationRules: tables.logCorrelationRules,
  logCorrelations: tables.logCorrelations,
  metricRollups: tables.metricRollups,
}));

import { buildAlertCorrelationRca } from './alertCorrelationRca';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ALERT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALERT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('alert correlation RCA evidence builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.devices = [{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'server-1', osType: 'windows' }];
    state.alertRuleSources = [{
      orgId: ORG_ID,
      ruleId: 'rule-1',
      templateId: 'template-1',
      ruleName: 'CPU threshold',
      ruleTargetType: 'device',
      ruleTargetId: DEVICE_ID,
      ruleIsActive: true,
      templateIdValue: 'template-1',
      templateName: 'Resource saturation',
      templateCategory: 'performance',
      templateSeverity: 'critical',
      templateIsBuiltIn: false,
      templateCooldownMinutes: 10,
    }];
    state.correlations = [{
      id: 'correlation-1',
      parentAlertId: ALERT_1,
      childAlertId: ALERT_2,
      correlationType: 'same_device_temporal',
      confidence: '0.91',
      metadata: {
        evidence: ['same_device', 'time_window', 'same_rule', 'shared_log_correlation', 'flapping_suppression'],
        ruleId: 'rule-1',
        templateId: 'template-1',
        logCorrelationIds: ['log-correlation-1'],
        logCorrelationRuleIds: ['log-rule-1'],
        logCorrelationRuleNames: ['Service crash burst'],
        logPatterns: ['service crashed'],
        logOccurrences: 7,
        logSeverity: 'critical',
        flappingDetected: true,
        flappingRuleIds: ['rule-1'],
        flappingDeviceIds: [DEVICE_ID],
      },
      createdAt: new Date('2026-06-18T12:03:00Z'),
    }];
    state.memberEvidence = [
      {
        orgId: ORG_ID,
        groupId: 'group-1',
        alertId: ALERT_1,
        role: 'root',
        confidence: '1.00',
        evidence: { version: 'alert-correlation-groups-v1', source: 'component-root' },
        updatedAt: new Date('2026-06-18T12:04:00Z'),
      },
      {
        orgId: ORG_ID,
        groupId: 'group-1',
        alertId: ALERT_2,
        role: 'related',
        confidence: '0.91',
        evidence: { version: 'alert-correlation-groups-v1', source: 'same-device' },
        updatedAt: new Date('2026-06-18T12:04:30Z'),
      },
    ];
    state.configPolicySources = [{
      orgId: ORG_ID,
      configPolicyAlertRuleId: 'cpar-1',
      configPolicyAlertRuleName: 'Memory threshold',
      configPolicyAlertSeverity: 'high',
      configPolicyAlertCooldownMinutes: 15,
      featureLinkId: 'feature-link-1',
      featureType: 'alerts',
      configurationPolicyId: 'policy-1',
      configurationPolicyName: 'Server monitoring baseline',
      configurationPolicyStatus: 'active',
    }];
    state.linkedLogCorrelations = [{
      orgId: ORG_ID,
      alertId: ALERT_2,
      logCorrelationId: 'log-correlation-linked-1',
      logRuleId: 'log-rule-linked-1',
      logRuleName: 'Repeated memory service faults',
      logRulePattern: 'memory service fault',
      logRuleSeverity: 'error',
      detectedPattern: 'MemoryService crashed',
      firstSeen: new Date('2026-06-18T11:58:00Z'),
      lastSeen: new Date('2026-06-18T12:02:30Z'),
      occurrences: 5,
      affectedDevices: [{ deviceId: DEVICE_ID, hostname: 'server-1', count: 5 }],
      sampleLogs: [
        { id: 'sample-log-1', deviceId: DEVICE_ID, timestamp: '2026-06-18T12:00:00Z', level: 'error', source: 'system', message: 'MemoryService crashed' },
      ],
    }];
    state.context = [{
      id: 'ctx-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      contextType: 'issue',
      summary: 'Known CPU contention',
      details: { service: 'backup' },
      createdAt: new Date('2026-06-18T11:00:00Z'),
      resolvedAt: null,
    }];
    state.changes = [{
      id: 'change-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      timestamp: new Date('2026-06-18T11:30:00Z'),
      changeType: 'service',
      changeAction: 'modified',
      subject: 'Backup service schedule changed',
    }];
    state.eventLogs = [{
      id: 'event-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      timestamp: new Date('2026-06-18T12:01:00Z'),
      level: 'error',
      category: 'system',
      source: 'Service Control Manager',
      eventId: '7031',
      message: 'Service terminated unexpectedly',
    }];
    state.agentLogs = [{
      id: 'agent-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      timestamp: new Date('2026-06-18T12:02:00Z'),
      level: 'error',
      component: 'watchdog.service',
      message: 'Watchdog restart threshold exceeded',
    }];
    state.metricRollups = [{
      orgId: ORG_ID,
      sourceTable: 'device_metrics',
      deviceId: DEVICE_ID,
      bucketSeconds: 300,
      metricName: 'cpu_percent',
      bucketStart: new Date('2026-06-18T12:00:00Z'),
      avgValue: 92,
      maxValue: 99,
    }];
  });

  it('builds bounded evidence and likely-cause candidates for grouped alerts', async () => {
    const result = await buildAlertCorrelationRca({
      orgId: ORG_ID,
      groupId: 'group-1',
      groupScore: 0.91,
      windowHours: 4,
      maxEvidenceItems: 20,
      alerts: [
        { id: ALERT_1, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: 'rule-1', configPolicyId: null, configItemName: null, status: 'active', severity: 'critical', title: 'CPU high', message: 'CPU over 90%', context: { threshold: 90, observed: 96 }, triggeredAt: new Date('2026-06-18T12:00:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-06-18T12:00:00Z') },
        { id: ALERT_2, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: null, configPolicyId: 'cpar-1', configItemName: 'ram_percent', status: 'active', severity: 'high', title: 'Memory high', message: 'RAM over 90%', context: { threshold: 90, observed: 94 }, triggeredAt: new Date('2026-06-18T12:02:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-06-18T12:02:00Z') },
      ],
    });

    expect(result.scope).toMatchObject({
      orgId: ORG_ID,
      deviceIds: [DEVICE_ID],
      alertIds: [ALERT_1, ALERT_2],
    });
    expect(result.timeline.map((item) => item.source)).toEqual(expect.arrayContaining([
      'alert',
      'correlation',
      'device_change',
      'event_log',
      'agent_log',
      'metric_rollup',
    ]));
    const correlationEvidence = result.timeline.find((item) => item.source === 'correlation');
    expect(correlationEvidence?.summary).toContain('shared_log_correlation');
    expect(correlationEvidence?.summary).toContain('Service crash burst');
    expect(correlationEvidence?.summary).toContain('service crashed');
    expect(correlationEvidence?.summary).toContain('Flapping detected');
    expect(correlationEvidence?.metadata).toMatchObject({
      correlationId: 'correlation-1',
      parentAlertId: ALERT_1,
      childAlertId: ALERT_2,
      confidence: 0.91,
      evidence: ['same_device', 'time_window', 'same_rule', 'shared_log_correlation', 'flapping_suppression'],
      ruleId: 'rule-1',
      templateId: 'template-1',
      logCorrelationIds: ['log-correlation-1'],
      logCorrelationRuleNames: ['Service crash burst'],
      logPatterns: ['service crashed'],
      logOccurrences: 7,
      flappingDetected: true,
      flappingRuleIds: ['rule-1'],
      flappingDeviceIds: [DEVICE_ID],
    });
    const legacyAlertEvidence = result.timeline.find((item) => item.id === `alert:${ALERT_1}`);
    expect(legacyAlertEvidence?.summary).toContain('via rule "CPU threshold"');
    expect(legacyAlertEvidence?.metadata).toMatchObject({
      contextSummary: '{"threshold":90,"observed":96}',
      rule: {
        id: 'rule-1',
        name: 'CPU threshold',
        targetType: 'device',
        targetId: DEVICE_ID,
        isActive: true,
      },
      template: {
        id: 'template-1',
        name: 'Resource saturation',
        category: 'performance',
        severity: 'critical',
        isBuiltIn: false,
        cooldownMinutes: 10,
      },
      correlationMember: {
        role: 'root',
        confidence: 1,
        evidenceVersion: 'alert-correlation-groups-v1',
        updatedAt: '2026-06-18T12:04:00.000Z',
      },
    });
    const configAlertEvidence = result.timeline.find((item) => item.id === `alert:${ALERT_2}`);
    expect(configAlertEvidence?.summary).toContain('via config policy rule "Memory threshold"');
    expect(configAlertEvidence?.summary).toContain('linked log correlation "Repeated memory service faults"');
    expect(configAlertEvidence?.metadata).toMatchObject({
      contextSummary: '{"threshold":90,"observed":94}',
      configSource: {
        configPolicyAlertRuleId: 'cpar-1',
        configPolicyAlertRuleName: 'Memory threshold',
        severity: 'high',
        cooldownMinutes: 15,
        featureLinkId: 'feature-link-1',
        featureType: 'alerts',
        configurationPolicyId: 'policy-1',
        configurationPolicyName: 'Server monitoring baseline',
        configurationPolicyStatus: 'active',
        itemName: 'ram_percent',
      },
      linkedLogCorrelations: [{
        id: 'log-correlation-linked-1',
        ruleId: 'log-rule-linked-1',
        ruleName: 'Repeated memory service faults',
        ruleSeverity: 'error',
        rulePattern: 'memory service fault',
        detectedPattern: 'MemoryService crashed',
        firstSeen: '2026-06-18T11:58:00.000Z',
        lastSeen: '2026-06-18T12:02:30.000Z',
        occurrences: 5,
        affectedDevices: [{ deviceId: DEVICE_ID, hostname: 'server-1', count: 5 }],
        sampleLogIds: ['sample-log-1'],
      }],
      correlationMember: {
        role: 'related',
        confidence: 0.91,
        evidenceVersion: 'alert-correlation-groups-v1',
        updatedAt: '2026-06-18T12:04:30.000Z',
      },
    });
    expect(result.rootCauseCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ confidence: 0.91 }),
      expect.objectContaining({
        confidence: 0.64,
        summary: expect.stringContaining('flapping suppression evidence'),
        supportingEvidenceIds: [`correlation:${ALERT_1}:${ALERT_2}`],
      }),
      expect.objectContaining({ confidence: 0.58 }),
      expect.objectContaining({ confidence: 0.52 }),
    ]));
    expect(result.suggestedNextSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Validate the leading cause',
        riskTier: 'low',
        evidenceIds: expect.arrayContaining([`alert:${ALERT_1}`]),
      }),
      expect.objectContaining({
        title: 'Review recent changes',
        evidenceIds: ['device_change:change-1'],
      }),
      expect.objectContaining({
        title: 'Review flapping suppression',
        riskTier: 'low',
        evidenceIds: [`correlation:${ALERT_1}:${ALERT_2}`],
      }),
      expect.objectContaining({
        title: 'Inspect aligned error logs',
      }),
    ]));
    expect(result.gaps).toEqual([]);
  });

  it('keeps high-importance evidence over earlier low-weight noise when truncating', async () => {
    // Flood the window with many low-weight device_context items that are EARLIER in time than
    // the single high-weight device_change. An earliest-N truncation would keep the noise and
    // drop the change; importance-first selection must retain the change.
    state.correlations = [];
    state.linkedLogCorrelations = [];
    state.eventLogs = [];
    state.agentLogs = [];
    state.metricRollups = [];
    state.context = Array.from({ length: 8 }, (_unused, index) => ({
      id: `ctx-${index}`,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      contextType: 'issue',
      summary: `Low-signal context ${index}`,
      details: null,
      // All earlier than the change below.
      createdAt: new Date(`2026-06-18T10:0${index}:00Z`),
      resolvedAt: null,
    }));
    state.changes = [{
      id: 'change-late',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      // Latest timestamp in the set — would be dropped by an earliest-N slice.
      timestamp: new Date('2026-06-18T11:59:00Z'),
      changeType: 'service',
      changeAction: 'modified',
      subject: 'Backup service schedule changed',
    }];

    const result = await buildAlertCorrelationRca({
      orgId: ORG_ID,
      groupId: 'group-1',
      groupScore: 0.5,
      windowHours: 4,
      // Smallest allowed cap (clamped to 5): 1 alert + 1 change + 3 context. The high-weight
      // change must survive even though 5 of the 8 context items are earlier in time.
      maxEvidenceItems: 5,
      alerts: [
        { id: ALERT_1, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: 'rule-1', configPolicyId: null, configItemName: null, status: 'active', severity: 'critical', title: 'CPU high', message: 'CPU over 90%', context: {}, triggeredAt: new Date('2026-06-18T12:00:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-06-18T12:00:00Z') },
      ],
    });

    expect(result.timeline).toHaveLength(5);
    const sources = result.timeline.map((item) => item.source);
    expect(sources).toContain('alert');
    expect(sources).toContain('device_change');
    expect(result.timeline.find((item) => item.id === 'device_change:change-late')).toBeDefined();
    // Timeline is still chronologically ordered for display.
    const timestamps = result.timeline.map((item) => new Date(item.timestamp).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    // The candidate heuristics still find the change in the truncated timeline.
    expect(result.rootCauseCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ confidence: 0.58, supportingEvidenceIds: ['device_change:change-late'] }),
    ]));
  });

  it('caps RCA evidence windows relative to old incident time instead of now', async () => {
    state.eventLogs = [
      {
        id: 'event-in-window',
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        timestamp: new Date('2026-01-15T12:15:00Z'),
        level: 'error',
        category: 'system',
        source: 'Service Control Manager',
        eventId: '7031',
        message: 'Incident-window service failure',
      },
      {
        id: 'event-today',
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        timestamp: new Date('2026-06-18T12:15:00Z'),
        level: 'error',
        category: 'system',
        source: 'Service Control Manager',
        eventId: '7031',
        message: 'Unrelated recent failure',
      },
    ];

    const result = await buildAlertCorrelationRca({
      orgId: ORG_ID,
      groupId: 'old-group',
      windowHours: 4,
      maxEvidenceItems: 20,
      alerts: [
        { id: ALERT_1, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: 'rule-1', configPolicyId: null, configItemName: null, status: 'active', severity: 'critical', title: 'CPU high', message: 'CPU over 90%', context: {}, triggeredAt: new Date('2026-01-15T12:00:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-01-15T12:00:00Z') },
      ],
    });

    expect(result.scope.windowStart).toBe('2026-01-15T08:00:00.000Z');
    expect(result.scope.windowEnd).toBe('2026-01-15T13:00:00.000Z');
    expect(result.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'event_log:event-in-window' }),
    ]));
    expect(result.timeline).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'event_log:event-today' }),
    ]));
  });
});
