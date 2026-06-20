import { describe, expect, it } from 'vitest';
import {
  automationQueueJobDataSchema,
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
