import { describe, expect, it } from 'vitest';
import { inspectDefinitionForSecrets } from './exportSafety';
import {
  automationExportEnvelopeSchema,
  backupConfigurationExportEnvelopeSchema,
  configurationAssignmentExportEnvelopeSchema,
  configurationPolicyExportEnvelopeSchema,
  customFieldExportEnvelopeSchema,
  customFieldValueExportEnvelopeSchema,
  scriptExportEnvelopeSchema,
} from './schemas';

const ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const base = { id: ID, orgId: ORG_ID, siteId: null, sourceUpdatedAt: '2026-07-14T12:00:00.000Z', revision: 'a'.repeat(64) };
const envelope = (record: Record<string, unknown>) => ({
  schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: [{ ...base, ...record }],
  nextCursor: null, hasMore: false,
});

const cases = [
  ['configuration-policies', configurationPolicyExportEnvelopeSchema, { sourceScope: 'organization', name: 'P', description: null, status: 'active', features: [{ id: ID, type: 'patch', policyId: null, settings: { schedule: 'weekly' } }] }],
  ['configuration-assignments', configurationAssignmentExportEnvelopeSchema, { policyId: ID, policyName: 'P', sourceScope: 'organization', level: 'organization', targetId: ORG_ID, priority: 0, roleFilter: null, osFilter: null }],
  ['scripts', scriptExportEnvelopeSchema, { sourceScope: 'organization', name: 'S', description: null, category: null, osTypes: ['linux'], language: 'bash', content: 'true', parameters: null, timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null }],
  ['automations', automationExportEnvelopeSchema, { sourceScope: 'organization', name: 'A', description: null, enabled: true, trigger: { type: 'manual' }, conditions: null, actions: [{ type: 'reboot' }], onFailure: 'stop', notificationTargets: null, dependencies: [] }],
  ['backup-configurations', backupConfigurationExportEnvelopeSchema, { kind: 'destination', sourceScope: 'organization', name: 'B', type: 'file', provider: 'local', compression: true, encryption: false, active: true, default: true, schedule: null, retention: null, exclusions: [], completenessGaps: [{ code: 'restore_procedure_unavailable' }] }],
  ['custom-fields', customFieldExportEnvelopeSchema, { sourceScope: 'organization', name: 'C', fieldKey: 'c', type: 'text', options: null, required: false, defaultValue: null, deviceTypes: null }],
  ['custom-field-values', customFieldValueExportEnvelopeSchema, { deviceId: ID, definitionId: '22222222-2222-4222-8222-222222222222', target: { type: 'device', id: ID }, name: 'C', fieldKey: 'c', type: 'text', value: 'safe' }],
] as const;

function fieldShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [fieldShape(value[0])];
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, fieldShape(child)]));
}

describe('desired-configuration DTO safety contract', () => {
  it.each(cases)('validates and snapshots the reviewed field set for %s', (_resource, schema, record) => {
    const parsed = schema.parse(envelope(record));
    expect(inspectDefinitionForSecrets(parsed)).toEqual({ safe: true });
    expect(fieldShape(parsed.data[0])).toMatchSnapshot();
  });

  it.each(cases)('strictly rejects unreviewed response keys for %s', (_resource, schema, record) => {
    const malicious = envelope({ ...record, providerConfig: { endpoint: 'ordinary-looking' } });
    expect(schema.safeParse(malicious).success).toBe(false);
  });

  it.each([
    ['password', { steps: [{ password: 'ordinary' }] }],
    ['token', { actions: [{ token: 'ordinary' }] }],
    ['privateKey', { nested: { privateKey: 'ordinary' } }],
    ['authorization', { headers: { authorization: 'ordinary' } }],
    ['providerConfig', { providerConfig: { endpoint: 'ordinary' } }],
    ['encryptionKey', { destination: { encryptionKey: 'ordinary' } }],
    ['embedded credentials', { endpoint: 'https://operator:hunter2@example.test/v1' }],
    ['high entropy', { value: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }],
  ])('recursively blocks malicious %s values', (_name, value) => {
    expect(inspectDefinitionForSecrets(value)).toMatchObject({ safe: false, reason: 'secret_detected' });
  });

  it('bounds blocked paths and never preserves a secret-derived value or hash', () => {
    const malicious: Record<string, unknown> = {};
    for (let index = 0; index < 50; index += 1) malicious[`branch-${index}`] = { password: `unsafe-${index}` };
    const inspected = inspectDefinitionForSecrets(malicious);
    expect(inspected).toMatchObject({ safe: false, reason: 'secret_detected' });
    if (inspected.safe) throw new Error('expected blocked inspection');
    expect(inspected.fieldPaths).toHaveLength(20);
    expect(JSON.stringify(inspected)).not.toContain('unsafe-');
  });
});
