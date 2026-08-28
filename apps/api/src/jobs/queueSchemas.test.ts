import { describe, expect, it } from 'vitest';
import {
  automationQueueJobDataSchema,
  backupProcessResultSchema,
  deviceAdjacencySchema,
  discoveryQueueJobDataSchema,
  fdbEntrySchema,
  sensitiveDataQueueJobDataSchema,
  desktopSessionFinalizationJobDataSchema,
  routeEventJobDataSchema,
  deliverEventJobDataSchema,
} from './queueSchemas';

describe('desktopSessionFinalizationJobDataSchema', () => {
  const valid = {
    version: 1 as const,
    sessionId: '11111111-1111-4111-8111-111111111111',
    finalizationId: '22222222-2222-4222-8222-222222222222',
  };

  it('accepts only the versioned stable identifiers', () => {
    expect(desktopSessionFinalizationJobDataSchema.parse(valid)).toEqual(valid);
    expect(() => desktopSessionFinalizationJobDataSchema.parse({
      ...valid,
      canonicalPayload: '{}',
    })).toThrow();
  });

  it('rejects invalid identifiers and versions', () => {
    expect(() => desktopSessionFinalizationJobDataSchema.parse({
      ...valid,
      sessionId: 'not-a-uuid',
    })).toThrow();
    expect(() => desktopSessionFinalizationJobDataSchema.parse({
      ...valid,
      version: 2,
    })).toThrow();
  });
});

describe('automationQueueJobDataSchema', () => {
  const validCases: Array<{ name: string; payload: Record<string, unknown> }> = [
    {
      name: 'scan-schedules',
      payload: { type: 'scan-schedules', scanAt: '2026-06-19T00:00:00.000Z' },
    },
    {
      name: 'trigger-schedule',
      payload: {
        type: 'trigger-schedule',
        automationId: 'auto-1',
        slotKey: 'slot-1',
        scanAt: '2026-06-19T00:00:00.000Z',
      },
    },
    {
      name: 'trigger-event (minimal)',
      payload: {
        type: 'trigger-event',
        automationId: 'auto-1',
        eventType: 'device.online',
        eventTimestamp: '2026-06-19T00:00:00.000Z',
      },
    },
    {
      name: 'trigger-event (with optional eventId + eventPayload)',
      payload: {
        type: 'trigger-event',
        automationId: 'auto-1',
        eventType: 'device.online',
        eventId: 'evt-1',
        eventPayload: { deviceId: 'dev-1', nested: { ok: true } },
        eventTimestamp: '2026-06-19T00:00:00.000Z',
      },
    },
    {
      // Backward compatibility: pre-deploy execute-run jobs have no triggerContext.
      name: 'execute-run',
      payload: { type: 'execute-run', runId: 'run-1', targetDeviceIds: ['device-1'] },
    },
    {
      name: 'execute-run (with triggerContext)',
      payload: {
        type: 'execute-run',
        runId: 'run-1',
        targetDeviceIds: ['device-1'],
        triggerContext: {
          alertId: 'alert-1',
          eventId: 'evt-1',
          severity: 'critical',
          ruleId: null,
        },
      },
    },
    {
      name: 'trigger-config-policy-schedule (assignmentTargets[])',
      payload: {
        type: 'trigger-config-policy-schedule',
        configPolicyAutomationId: 'cpa-1',
        configPolicyAutomationName: 'CP Automation',
        assignmentTargets: [
          { level: 'site', targetId: 'site-1' },
          { level: 'organization', targetId: 'org-1' },
        ],
        policyId: 'pol-1',
        policyName: 'Policy',
        slotKey: 'slot-1',
        scanAt: '2026-06-19T00:00:00.000Z',
      },
    },
    {
      // Pre-deploy Redis-resident jobs carry the legacy single-target fields and
      // no assignmentTargets[] array — these MUST still parse after this change.
      name: 'trigger-config-policy-schedule (legacy single-target backward-compat)',
      payload: {
        type: 'trigger-config-policy-schedule',
        configPolicyAutomationId: 'cpa-1',
        configPolicyAutomationName: 'CP Automation',
        assignmentLevel: 'device',
        assignmentTargetId: 'dev-1',
        policyId: 'pol-1',
        policyName: 'Policy',
        slotKey: 'slot-1',
        scanAt: '2026-06-19T00:00:00.000Z',
      },
    },
    {
      name: 'execute-config-policy-run',
      payload: {
        type: 'execute-config-policy-run',
        configPolicyAutomationId: 'cpa-1',
        targetDeviceIds: ['dev-1', 'dev-2'],
        triggeredBy: 'schedule:slot-1',
      },
    },
  ];

  it.each(validCases)('accepts a valid $name job', ({ payload }) => {
    expect(automationQueueJobDataSchema.parse(payload)).toEqual(payload);
  });

  const malformedCases: Array<{ name: string; payload: Record<string, unknown> }> = [
    {
      name: 'scan-schedules missing scanAt',
      payload: { type: 'scan-schedules' },
    },
    {
      name: 'trigger-schedule with empty automationId',
      payload: { type: 'trigger-schedule', automationId: '', slotKey: 's', scanAt: 'now' },
    },
    {
      name: 'trigger-event missing eventTimestamp',
      payload: { type: 'trigger-event', automationId: 'a', eventType: 'e' },
    },
    {
      name: 'execute-run with empty runId and unexpected key',
      payload: { type: 'execute-run', runId: '', unexpected: true },
    },
    {
      name: 'execute-run with an out-of-enum triggerContext severity',
      payload: {
        type: 'execute-run',
        runId: 'run-1',
        triggerContext: {
          alertId: 'alert-1',
          eventId: 'evt-1',
          severity: 'urgent',
          ruleId: 'rule-1',
        },
      },
    },
    {
      name: 'execute-run with an unknown key inside triggerContext',
      payload: {
        type: 'execute-run',
        runId: 'run-1',
        triggerContext: {
          alertId: 'alert-1',
          eventId: 'evt-1',
          severity: 'high',
          ruleId: 'rule-1',
          unexpected: true,
        },
      },
    },
    {
      name: 'trigger-config-policy-schedule with an out-of-enum level',
      payload: {
        type: 'trigger-config-policy-schedule',
        configPolicyAutomationId: 'cpa-1',
        configPolicyAutomationName: 'CP Automation',
        assignmentTargets: [{ level: 'bogus-level', targetId: 'x' }],
        policyId: 'pol-1',
        policyName: 'Policy',
        slotKey: 'slot-1',
        scanAt: 'now',
      },
    },
    {
      name: 'trigger-config-policy-schedule with an out-of-enum legacy assignmentLevel',
      payload: {
        type: 'trigger-config-policy-schedule',
        configPolicyAutomationId: 'cpa-1',
        configPolicyAutomationName: 'CP Automation',
        assignmentLevel: 'galaxy',
        assignmentTargetId: 'x',
        policyId: 'pol-1',
        policyName: 'Policy',
        slotKey: 'slot-1',
        scanAt: 'now',
      },
    },
    {
      name: 'execute-config-policy-run missing triggeredBy',
      payload: {
        type: 'execute-config-policy-run',
        configPolicyAutomationId: 'cpa-1',
        targetDeviceIds: ['dev-1'],
      },
    },
    {
      name: 'unknown discriminator type',
      payload: { type: 'totally-unknown' },
    },
  ];

  it.each(malformedCases)('rejects a malformed $name job', ({ payload }) => {
    expect(() => automationQueueJobDataSchema.parse(payload)).toThrow();
  });
});

describe('sensitiveDataQueueJobDataSchema', () => {
  const validCases: Array<{ name: string; payload: Record<string, unknown> }> = [
    { name: 'dispatch-scan', payload: { type: 'dispatch-scan', scanId: 'scan-1' } },
    {
      name: 'schedule-policies',
      payload: { type: 'schedule-policies', scanAt: '2026-06-19T00:00:00.000Z' },
    },
  ];

  it.each(validCases)('accepts a valid $name job', ({ payload }) => {
    expect(sensitiveDataQueueJobDataSchema.parse(payload)).toEqual(payload);
  });

  const malformedCases: Array<{ name: string; payload: Record<string, unknown> }> = [
    { name: 'dispatch-scan with empty scanId', payload: { type: 'dispatch-scan', scanId: '' } },
    { name: 'schedule-policies missing scanAt', payload: { type: 'schedule-policies' } },
    {
      name: 'schedule-policies with an unexpected key',
      payload: { type: 'schedule-policies', scanAt: 'now', unexpected: true },
    },
    { name: 'unknown discriminator type', payload: { type: 'nope' } },
  ];

  it.each(malformedCases)('rejects a malformed $name job', ({ payload }) => {
    expect(() => sensitiveDataQueueJobDataSchema.parse(payload)).toThrow();
  });
});

describe('backupProcessResultSchema — system_image manifest passthrough', () => {
  // Regression guard: this strict schema previously lacked backupType/
  // systemStateManifest, so enqueueBackupResults threw an unrecognized_keys
  // ZodError and the system_image job hung in "running" forever.
  it('accepts a system_image result carrying backupType + systemStateManifest', () => {
    const result = backupProcessResultSchema.parse({
      status: 'completed',
      snapshotId: 'snap-1',
      filesBackedUp: 13,
      bytesBackedUp: 103,
      backupType: 'system_image',
      systemStateManifest: {
        platform: 'windows',
        osVersion: 'Windows Server 2022',
        artifacts: [{ name: 'registry_SYSTEM', category: 'registry' }],
        hardwareProfile: { cpuCores: 4, totalMemoryMB: 8192 },
      },
    });
    expect(result.backupType).toBe('system_image');
    // The record is open — arbitrary manifest keys survive intact.
    expect((result.systemStateManifest as { platform: string }).platform).toBe('windows');
  });

  it('allows an unmodeled manifest key (open record) without failing the job', () => {
    expect(() =>
      backupProcessResultSchema.parse({
        status: 'completed',
        systemStateManifest: { platform: 'windows', someFutureField: { nested: true } },
      }),
    ).not.toThrow();
  });

  it('still rejects an unknown TOP-LEVEL key (schema is .strict())', () => {
    // The manifest is permissive, but the result envelope is not — a new
    // top-level field must be declared or the whole job fails validation.
    expect(() =>
      backupProcessResultSchema.parse({ status: 'completed', bogusTopLevel: true }),
    ).toThrow();
  });

  it('accepts a null systemStateManifest (file/mssql/hyperv results)', () => {
    expect(() =>
      backupProcessResultSchema.parse({ status: 'completed', systemStateManifest: null }),
    ).not.toThrow();
  });
});

describe('backupProcessResultSchema — incremental dedup + partial-success passthrough', () => {
  // Regression guard: same failure mode as the system_image block above — the
  // strict schema (and the WS enqueue call) lacked referencedFiles/
  // referencedBytes/errorCount, so an incremental job's upload savings and
  // partial-failure count were silently dropped whenever Redis was available
  // (the inline no-Redis fallback spread the full result and kept them).
  it('accepts and preserves referencedFiles/referencedBytes/errorCount', () => {
    const result = backupProcessResultSchema.parse({
      status: 'completed',
      snapshotId: 'snap-2',
      filesBackedUp: 15,
      bytesBackedUp: 14614591,
      referencedFiles: 13,
      referencedBytes: 14351000,
      errorCount: 2,
    });
    expect(result.referencedFiles).toBe(13);
    expect(result.referencedBytes).toBe(14351000);
    expect(result.errorCount).toBe(2);
  });

  it('leaves the fields undefined when omitted (legacy agent / full backup)', () => {
    const result = backupProcessResultSchema.parse({ status: 'completed' });
    expect(result.referencedFiles).toBeUndefined();
    expect(result.referencedBytes).toBeUndefined();
    expect(result.errorCount).toBeUndefined();
  });
});

describe('discovery process-results adjacency', () => {
  const base = {
    type: 'process-results' as const,
    jobId: 'job-1', orgId: 'org-1', siteId: 'site-1',
    hosts: [], hostsScanned: 0, hostsDiscovered: 0,
  };
  it('accepts an adjacency block with lldp/cdp/fdb', () => {
    const parsed = discoveryQueueJobDataSchema.parse({
      ...base,
      adjacency: [{
        sourceDeviceIp: '10.0.0.1', sourceChassisId: 'aa:bb:cc:dd:ee:ff',
        lldp: [{ localPort: '1', remoteChassisId: 'a1:b2:c3:d4:e5:f6', remotePortId: 'Gi0/1', remoteSysName: 'core' }],
        cdp: [], fdb: [],
      }],
    });
    expect(parsed.type).toBe('process-results');
  });
  it('accepts a payload without adjacency (optional)', () => {
    expect(() => discoveryQueueJobDataSchema.parse(base)).not.toThrow();
  });
});

describe('fdb adjacency schema (Phase 2)', () => {
  it('parses a DeviceAdjacency with a fully-populated fdb entry', () => {
    const parsed = deviceAdjacencySchema.parse({
      sourceDeviceIp: '10.0.0.1',
      lldp: [],
      cdp: [],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5', vlan: 100 }],
    });
    expect(parsed.fdb).toHaveLength(1);
    expect(parsed.fdb[0]).toEqual({ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5', vlan: 100 });
  });

  it('rejects an fdb entry with an extra unknown key (.strict())', () => {
    expect(() =>
      fdbEntrySchema.parse({ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, unexpected: true }),
    ).toThrow();
  });

  it('defaults fdb to [] when omitted', () => {
    const parsed = deviceAdjacencySchema.parse({
      sourceDeviceIp: '10.0.0.1',
      lldp: [],
      cdp: [],
    });
    expect(parsed.fdb).toEqual([]);
  });
});

// #3000: backupProcessResultSchema is .strict(), so the agent's own terminal
// status must be declared or the whole queue job fails validation and the
// backup result is lost. It rides a DISTINCT key because `status` on this
// payload already means the outer completed/failed command status.
describe('backupProcessResultSchema — agentStatus (#3000)', () => {
  it('carries agentStatus alongside the outer status', () => {
    const parsed = backupProcessResultSchema.parse({
      status: 'completed',
      agentStatus: 'partial',
      snapshotId: 'snap-1',
      errorCount: 21,
    });
    expect(parsed.status).toBe('completed');
    expect(parsed.agentStatus).toBe('partial');
  });

  it('stays valid when a legacy agent sends no agentStatus', () => {
    const parsed = backupProcessResultSchema.parse({ status: 'completed', snapshotId: 'snap-1' });
    expect(parsed.agentStatus).toBeUndefined();
  });

  it('carries vssMetadata across the .strict() boundary (#3027)', () => {
    // The schema is .strict(), so an undeclared top-level key throws inside
    // enqueueBackupResults BEFORE queue.add — the whole terminal result would
    // be lost, not just the diagnostics.
    const parsed = backupProcessResultSchema.parse({
      status: 'completed',
      snapshotId: 'snap-1',
      vssMetadata: { shadowCopyId: 'set-1', unprotectedVolumes: ['D:\\'] },
    });
    expect(parsed.vssMetadata).toEqual({ shadowCopyId: 'set-1', unprotectedVolumes: ['D:\\'] });
  });

  it('never rejects the queue payload over a malformed vssMetadata', () => {
    // Same reasoning as the ingress schema: this parse throws before the job is
    // enqueued, so a shape assertion here would discard the snapshot id and
    // counters over a diagnostics blob. Bounding happens at the DB write.
    for (const vssMetadata of [{ writers: 'not-an-array' }, 'bare string', 7, [], null]) {
      const parsed = backupProcessResultSchema.safeParse({
        status: 'completed',
        snapshotId: 'snap-1',
        vssMetadata,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.snapshotId).toBe('snap-1');
    }
  });
});

// Wave 3.5c dispatch queue (#4085 task 5).
describe('routeEventJobDataSchema', () => {
  const baseEvent = {
    id: 'evt-1',
    type: 'device.online',
    orgId: 'org-1',
    source: 'unit-test',
    priority: 'normal' as const,
    payload: { deviceId: 'dev-1' },
    metadata: { timestamp: '2026-08-26T00:00:00.000Z' },
  };

  it('accepts a valid shadow-mode route-event job', () => {
    const payload = {
      v: 1 as const,
      mode: 'shadow' as const,
      event: baseEvent,
      matchedSubscriberIds: ['automation-worker', 'webhook-delivery'],
      queueSubscriberIds: ['automation-worker', 'webhook-delivery'],
    };
    expect(routeEventJobDataSchema.parse(payload)).toEqual(payload);
  });

  it('accepts a valid enforce-mode job with a proper subset queueSubscriberIds', () => {
    const payload = {
      v: 1 as const,
      mode: 'enforce' as const,
      event: baseEvent,
      matchedSubscriberIds: ['automation-worker', 'webhook-delivery'],
      queueSubscriberIds: ['webhook-delivery'],
    };
    expect(routeEventJobDataSchema.parse(payload)).toEqual(payload);
  });

  it('accepts optional siteId/audienceUserId and open payload/correlation fields on the event', () => {
    const payload = {
      v: 1 as const,
      mode: 'shadow' as const,
      event: {
        ...baseEvent,
        siteId: 'site-1',
        audienceUserId: 'user-1',
        payload: { nested: { anything: true } },
        metadata: { ...baseEvent.metadata, correlationId: 'c-1', causationId: 'ca-1', userId: 'u-1' },
      },
      matchedSubscriberIds: [],
      queueSubscriberIds: [],
    };
    expect(() => routeEventJobDataSchema.parse(payload)).not.toThrow();
  });

  it('rejects an unknown subscriber id (drift guard against eventSubscriberIds.ts)', () => {
    const payload = {
      v: 1 as const,
      mode: 'shadow' as const,
      event: baseEvent,
      matchedSubscriberIds: ['not-a-real-subscriber'],
      queueSubscriberIds: [],
    };
    expect(() => routeEventJobDataSchema.parse(payload)).toThrow();
  });

  it('rejects an unknown top-level key (.strict())', () => {
    const payload = {
      v: 1 as const,
      mode: 'shadow' as const,
      event: baseEvent,
      matchedSubscriberIds: [],
      queueSubscriberIds: [],
      unexpected: true,
    };
    expect(() => routeEventJobDataSchema.parse(payload)).toThrow();
  });

  it('rejects an unknown top-level key on the nested event (.strict())', () => {
    const payload = {
      v: 1 as const,
      mode: 'shadow' as const,
      event: { ...baseEvent, unexpectedField: 'nope' },
      matchedSubscriberIds: [],
      queueSubscriberIds: [],
    };
    expect(() => routeEventJobDataSchema.parse(payload)).toThrow();
  });

  it('rejects a version other than 1 and a mode outside shadow|enforce', () => {
    expect(() =>
      routeEventJobDataSchema.parse({
        v: 2,
        mode: 'shadow',
        event: baseEvent,
        matchedSubscriberIds: [],
        queueSubscriberIds: [],
      }),
    ).toThrow();
    expect(() =>
      routeEventJobDataSchema.parse({
        v: 1,
        mode: 'off',
        event: baseEvent,
        matchedSubscriberIds: [],
        queueSubscriberIds: [],
      }),
    ).toThrow();
  });
});

describe('deliverEventJobDataSchema', () => {
  const baseEvent = {
    id: 'evt-1',
    type: 'alert.triggered',
    orgId: 'org-1',
    source: 'unit-test',
    priority: 'high' as const,
    payload: { alertId: 'a-1' },
    metadata: { timestamp: '2026-08-26T00:00:00.000Z' },
  };

  it('accepts a valid deliver-event job for a known subscriber', () => {
    const payload = { v: 1 as const, subscriberId: 'webhook-delivery' as const, event: baseEvent };
    expect(deliverEventJobDataSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an unknown subscriberId', () => {
    expect(() =>
      deliverEventJobDataSchema.parse({ v: 1, subscriberId: 'bogus-subscriber', event: baseEvent }),
    ).toThrow();
  });

  it('rejects an unknown top-level key (.strict())', () => {
    expect(() =>
      deliverEventJobDataSchema.parse({
        v: 1,
        subscriberId: 'webhook-delivery',
        event: baseEvent,
        unexpected: true,
      }),
    ).toThrow();
  });
});
