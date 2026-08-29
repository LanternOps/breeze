import { describe, expect, it } from 'vitest';
import { createAiAgentScheduleSchema, updateAiAgentScheduleSchema, sweepFindingsOutcomeSchema, sweepProposedActionSchema } from './aiAgentSchedules';

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

// Final-review fix (#4189, item 3a) — the CADENCE FLOOR. A sweep occurrence
// fans out one LLM-spending run per org under the partner, so a sub-hourly
// cron is a fleet-wide cost/rate multiplier a single PATCH can turn on. The
// minute field must therefore be a literal integer or a comma-separated list
// of them: no `*`, no step (`*/15`), no range (`0-5`).
describe('scheduleCronSchema — hourly cadence floor', () => {
  const partner = (cron: string) => ({
    ownerScope: 'partner' as const, agentId: uuid, cron, timezone: 'UTC',
    sweepKinds: ['disk_pressure'], enabled: true,
  });
  const parse = (cron: string) => createAiAgentScheduleSchema.safeParse(partner(cron));

  it('accepts a single literal minute and a comma-separated minute list', () => {
    expect(parse('0 6 * * 1-5').success).toBe(true);
    expect(parse('0,30 * * * *').success).toBe(true);
    expect(parse('59 23 * * *').success).toBe(true);
  });

  it('rejects a stepped, wildcard, or ranged minute field', () => {
    expect(parse('*/15 * * * *').success).toBe(false);
    expect(parse('* * * * *').success).toBe(false);
    expect(parse('0-5 6 * * *').success).toBe(false);
    expect(parse('0/2 6 * * *').success).toBe(false);
  });

  it('names the cadence floor in the rejection message', () => {
    const result = parse('*/15 * * * *');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('sweep schedules fire at most hourly');
  });

  it('applies the same floor to the update schema', () => {
    expect(updateAiAgentScheduleSchema.safeParse({ cron: '*/15 * * * *' }).success).toBe(false);
    expect(updateAiAgentScheduleSchema.safeParse({ cron: '0 6 * * *' }).success).toBe(true);
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

// Review round 1 (Important): every numeric/length cap the brief bound on
// these three schemas needs an explicit AT-the-bound (accepted) / OVER-the-
// bound (rejected) pair, so a regression on any single cap fails loudly
// instead of only showing up against a live evidence payload later.
describe('sweepFindingsOutcomeSchema numeric bounds', () => {
  const minimalFinding = () => ({
    kind: 'service_down',
    severity: 'high',
    title: 't',
    detail: 'd',
    evidence: {},
  });

  it('findings: accepts exactly 50, rejects 51', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: Array.from({ length: 50 }, minimalFinding) }).success).toBe(true);
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: Array.from({ length: 51 }, minimalFinding) }).success).toBe(false);
  });

  it('finding.title: accepts 120 chars, rejects 121', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), title: 'x'.repeat(120) }] }).success).toBe(true);
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), title: 'x'.repeat(121) }] }).success).toBe(false);
  });

  it('finding.detail: accepts 600 chars, rejects 601', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), detail: 'x'.repeat(600) }] }).success).toBe(true);
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), detail: 'x'.repeat(601) }] }).success).toBe(false);
  });

  it('finding.evidence: accepts exactly 20 keys, rejects 21', () => {
    const evidence20 = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const evidence21 = { ...evidence20, k20: 20 };
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), evidence: evidence20 }] }).success).toBe(true);
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), evidence: evidence21 }] }).success).toBe(false);
  });

  it('finding.evidence: rejects a nested-object value (scalar values only)', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [{ ...minimalFinding(), evidence: { nested: { deep: 1 } } }] }).success).toBe(false);
  });

  it('summary: accepts 400 chars, rejects 401', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 'x'.repeat(400), findings: [] }).success).toBe(true);
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 'x'.repeat(401), findings: [] }).success).toBe(false);
  });
});

describe('sweepProposedActionSchema numeric bounds', () => {
  it('manage_services.serviceName: rejects empty, accepts 1 and 255 chars, rejects 256', () => {
    const base = { tool: 'manage_services' as const, action: 'restart' as const, deviceId: uuid };
    expect(sweepProposedActionSchema.safeParse({ ...base, serviceName: '' }).success).toBe(false);
    expect(sweepProposedActionSchema.safeParse({ ...base, serviceName: 'x' }).success).toBe(true);
    expect(sweepProposedActionSchema.safeParse({ ...base, serviceName: 'x'.repeat(255) }).success).toBe(true);
    expect(sweepProposedActionSchema.safeParse({ ...base, serviceName: 'x'.repeat(256) }).success).toBe(false);
  });

  it('remediate_vulnerability.deviceVulnerabilityIds: rejects empty, accepts 1 and 100 uuids, rejects 101', () => {
    const base = { tool: 'remediate_vulnerability' as const, deviceId: uuid };
    const uuidsOf = (n: number) => Array.from({ length: n }, () => uuid);
    expect(sweepProposedActionSchema.safeParse({ ...base, deviceVulnerabilityIds: [] }).success).toBe(false);
    expect(sweepProposedActionSchema.safeParse({ ...base, deviceVulnerabilityIds: uuidsOf(1) }).success).toBe(true);
    expect(sweepProposedActionSchema.safeParse({ ...base, deviceVulnerabilityIds: uuidsOf(100) }).success).toBe(true);
    expect(sweepProposedActionSchema.safeParse({ ...base, deviceVulnerabilityIds: uuidsOf(101) }).success).toBe(false);
  });
});
