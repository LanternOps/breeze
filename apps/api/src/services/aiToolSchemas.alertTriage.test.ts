import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { alertTriageToolShapes, FLEET_HEALTH_ACTIONS } from './aiToolSchemasAlertTriage';
import { toolActionEnum } from './aiToolActions';

// W07 (#6777): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W07_TOOLS = Object.keys(alertTriageToolShapes);
const UUID = '11111111-1111-4111-8111-111111111111';
const shapeOf = (name: string) => (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;

describe('W07 alert-triage tool input schemas', () => {
  it('covers exactly the four new W07 tools', () => {
    expect([...W07_TOOLS].sort()).toEqual([
      'get_alert_correlations', 'manage_alert_correlations', 'manage_device_anomalies', 'reliability_feedback',
    ]);
  });

  it.each(W07_TOOLS)('%s: registry properties and Zod keys agree, strict', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shapeOf(name)).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(W07_TOOLS)('%s: every registry-required key is required by Zod too', (name) => {
    const required = (aiTools.get(name)!.definition.input_schema as { required?: string[] }).required ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) {
      expect(shapeOf(name)[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
  });

  it.each(['get_alert_correlations', 'manage_alert_correlations', 'manage_device_anomalies'])('%s: action enum agrees with the registry', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: { action: { enum: string[] } } };
    expect([...schema.properties.action.enum].sort()).toEqual([...(toolActionEnum(name) ?? [])].sort());
  });

  it('the new tools live in the expected domains and registry tiers', () => {
    expect(aiTools.get('get_alert_correlations')).toMatchObject({ domain: 'monitoring', tier: 1 });
    expect(aiTools.get('manage_alert_correlations')).toMatchObject({ domain: 'monitoring', tier: 2 });
    expect(aiTools.get('manage_device_anomalies')).toMatchObject({ domain: 'monitoring', tier: 1 });
    expect(aiTools.get('reliability_feedback')).toMatchObject({ domain: 'devices', tier: 2 });
  });

  it('device-addressed tools declare deviceId in deviceArgs so the central org+site+device gate runs', () => {
    for (const name of ['manage_device_anomalies', 'reliability_feedback', 'get_fleet_health']) {
      expect(aiTools.get(name)!.deviceArgs, name).toContain('deviceId');
    }
  });

  it.each(W07_TOOLS)('%s rejects an unknown key (strict)', (name) => {
    const base = name === 'reliability_feedback' ? { deviceId: UUID, outcome: 'replaced' }
      : name === 'manage_device_anomalies' ? { action: 'list', deviceId: UUID }
        : { action: name === 'get_alert_correlations' ? 'groups' : 'feedback' };
    expect(validateToolInput(name, base).success).toBe(true);
    expect(validateToolInput(name, { ...base, surprise: true }).success).toBe(false);
  });

  it('accepts representative valid inputs', () => {
    expect(validateToolInput('get_alert_correlations', { action: 'explain', groupId: UUID, windowHours: 6, maxEvidenceItems: 20 }).success).toBe(true);
    expect(validateToolInput('get_alert_correlations', { action: 'analyze', orgId: UUID, alertIds: [UUID], windowMinutes: 60 }).success).toBe(true);
    expect(validateToolInput('manage_alert_correlations', { action: 'feedback', groupId: UUID, outcome: 'merged', targetGroupId: UUID }).success).toBe(true);
    expect(validateToolInput('manage_alert_correlations', { action: 'rca_feedback', groupId: UUID, outcome: 'helpful' }).success).toBe(true);
    expect(validateToolInput('manage_device_anomalies', { action: 'promote', deviceId: UUID, anomalyId: UUID }).success).toBe(true);
    expect(validateToolInput('reliability_feedback', { deviceId: UUID, outcome: 'false_alarm', occurredAt: '2026-10-25T12:00:00Z' }).success).toBe(true);
  });

  it('rejects malformed ids, out-of-range numbers and unknown enum values', () => {
    expect(validateToolInput('get_alert_correlations', { action: 'get', groupId: 'nope' }).success).toBe(false);
    expect(validateToolInput('get_alert_correlations', { action: 'explain', groupId: UUID, windowHours: 25 }).success).toBe(false);
    expect(validateToolInput('get_alert_correlations', { action: 'analyze', windowMinutes: 4 }).success).toBe(false);
    expect(validateToolInput('get_alert_correlations', { action: 'links', minConfidence: 1.5 }).success).toBe(false);
    expect(validateToolInput('manage_alert_correlations', { action: 'feedback', outcome: 'exploded' }).success).toBe(false);
    expect(validateToolInput('manage_device_anomalies', { action: 'list' }).success).toBe(false); // deviceId is required
    expect(validateToolInput('manage_device_anomalies', { action: 'delete', deviceId: UUID }).success).toBe(false);
    expect(validateToolInput('reliability_feedback', { deviceId: UUID, outcome: 'fine' }).success).toBe(false);
  });

  it('get_fleet_health gains the W07 actions and keeps the default list valid', () => {
    expect([...FLEET_HEALTH_ACTIONS]).toEqual(['list', 'history', 'offenders', 'evaluation', 'org_summary']);
    expect(validateToolInput('get_fleet_health', {}).success).toBe(true);
    expect(validateToolInput('get_fleet_health', { scoreRange: 'critical', limit: 10 }).success).toBe(true);
    expect(validateToolInput('get_fleet_health', { action: 'history', deviceId: UUID, days: 30 }).success).toBe(true);
    expect(validateToolInput('get_fleet_health', { action: 'offenders', deviceId: UUID, topN: 5 }).success).toBe(true);
    expect(validateToolInput('get_fleet_health', { action: 'org_summary', orgId: UUID }).success).toBe(true);
    expect(validateToolInput('get_fleet_health', { action: 'evaluation', atRiskMaxScore: 60, labelWindowDays: 30 }).success).toBe(true);
    expect(validateToolInput('get_fleet_health', { action: 'offenders', topN: 21 }).success).toBe(false);
    expect(validateToolInput('get_fleet_health', { action: 'history', days: 0 }).success).toBe(false);
    expect(validateToolInput('get_fleet_health', { action: 'forecast' }).success).toBe(false);
  });
});
