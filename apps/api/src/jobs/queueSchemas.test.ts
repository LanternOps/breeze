import { describe, expect, it } from 'vitest';
import {
  automationQueueJobDataSchema,
  backupProcessResultSchema,
  deviceAdjacencySchema,
  discoveryQueueJobDataSchema,
  fdbEntrySchema,
  sensitiveDataQueueJobDataSchema,
} from './queueSchemas';

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
      name: 'execute-run',
      payload: { type: 'execute-run', runId: 'run-1', targetDeviceIds: ['device-1'] },
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
