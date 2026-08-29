import { describe, expect, it } from 'vitest';
import { createAiAgentScheduleSchema, updateAiAgentScheduleSchema, sweepFindingsOutcomeSchema } from './aiAgentSchedules';

const uuid = '11111111-1111-4111-8111-111111111111';
describe('createAiAgentScheduleSchema', () => {
  it('accepts a partner baseline', () => {
    expect(createAiAgentScheduleSchema.safeParse({ ownerScope: 'partner', agentId: uuid, cron: '0 6 * * 1-5', timezone: 'Europe/Berlin', sweepKinds: ['disk_pressure'], enabled: true }).success).toBe(true);
  });
  it('rejects a 6-field cron, an unknown timezone, an unknown kind, and an empty partner kinds list', () => {
    const base = { ownerScope: 'partner', agentId: uuid, cron: '0 6 * * 1-5', timezone: 'UTC', sweepKinds: ['disk_pressure'], enabled: true };
    expect(createAiAgentScheduleSchema.safeParse({ ...base, cron: '0 0 6 * * *' }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, sweepKinds: ['expiring_certs'] }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, sweepKinds: [] }).success).toBe(false);
  });
  it('an org override carries baselineScheduleId and no cron', () => {
    expect(createAiAgentScheduleSchema.safeParse({ ownerScope: 'organization', orgId: uuid, baselineScheduleId: uuid, enabled: false, sweepKinds: [] }).success).toBe(true);
    expect(createAiAgentScheduleSchema.safeParse({ ownerScope: 'organization', orgId: uuid, baselineScheduleId: uuid, cron: '0 6 * * *', enabled: true, sweepKinds: [] }).success).toBe(false);
  });
  it('update never admits ownerScope / agentId / baselineScheduleId', () => {
    expect(updateAiAgentScheduleSchema.safeParse({ ownerScope: 'partner' }).success).toBe(false);
    expect(updateAiAgentScheduleSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});
describe('sweepFindingsOutcomeSchema', () => {
  it('accepts a finding with a restart proposal and rejects a disk_cleanup proposal', () => {
    const ok = { summary: 's', findings: [{ kind: 'service_down', severity: 'high', deviceId: uuid, title: 't', detail: 'd', evidence: { service: 'spooler', status: 'stopped' }, proposedAction: { tool: 'manage_services', action: 'restart', deviceId: uuid, serviceName: 'spooler' } }] };
    expect(sweepFindingsOutcomeSchema.safeParse(ok).success).toBe(true);
    const bad = { ...ok, findings: [{ ...ok.findings[0], proposedAction: { tool: 'disk_cleanup', action: 'execute', deviceId: uuid } }] };
    expect(sweepFindingsOutcomeSchema.safeParse(bad).success).toBe(false);
  });
  it('is strict: unknown keys (args, toolOutput) are rejected', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [], toolOutput: 'x' }).success).toBe(false);
  });
});
