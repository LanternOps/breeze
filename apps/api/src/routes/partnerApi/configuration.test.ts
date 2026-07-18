import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_A = '44444444-4444-4444-8444-444444444444';
const SOURCE_B = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_AT = new Date('2026-07-10T12:00:00.000Z');
const UPDATED_AT = new Date('2026-07-12T12:00:00.000Z');
const PATCH_INLINE_MIRROR_MATERIAL = '__breezePatchInlineMirror';
const NORMALIZED_PATCH_FACTS = {
  sources: ['os'],
  autoApprove: false,
  autoApproveSeverities: [],
  scheduleFrequency: 'weekly',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
  rebootPolicy: 'if_required',
  exclusiveWindowsUpdate: false,
};

function patchMaterial(rawMirror: unknown = {}) {
  return {
    ...NORMALIZED_PATCH_FACTS,
    [PATCH_INLINE_MIRROR_MATERIAL]: rawMirror,
  };
}

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  accessibleOrgIds: [] as string[],
  queryResults: [] as Array<unknown[] | Error>,
}));

vi.mock('../../db', () => ({
  db: { execute: mocks.execute },
  hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerId: PARTNER_ID,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) =>
    required.every((scope) => c.get('partnerApiPrincipal').scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403),
}));

import { partnerApiRoutes } from './index';
import {
  automationExportEnvelopeSchema,
  backupConfigurationExportEnvelopeSchema,
  configurationAssignmentExportEnvelopeSchema,
  configurationPolicyExportEnvelopeSchema,
  customFieldExportEnvelopeSchema,
  customFieldValueExportEnvelopeSchema,
  scriptExportEnvelopeSchema,
} from './schemas';

const ROUTES = [
  ['/configuration-policies', 'configuration:read', configurationPolicyExportEnvelopeSchema],
  ['/configuration-assignments', 'configuration:read', configurationAssignmentExportEnvelopeSchema],
  ['/scripts', 'scripts:read', scriptExportEnvelopeSchema],
  ['/automations', 'configuration:read', automationExportEnvelopeSchema],
  ['/backup-configurations', 'backup-configuration:read', backupConfigurationExportEnvelopeSchema],
  ['/custom-fields', 'custom-fields:read', customFieldExportEnvelopeSchema],
  ['/custom-field-values', 'custom-fields:read', customFieldValueExportEnvelopeSchema],
] as const;

function row(id: string, orgId: string, definition: Record<string, unknown>, updatedAt = UPDATED_AT) {
  return { id, orgId, siteId: null, createdAt: CREATED_AT, updatedAt, definition };
}

function request(path: string, scope: string, apiKey = 'test-key') {
  return app.request(`/partner-api${path}`, {
    headers: { 'X-API-Key': apiKey, 'X-Test-Scopes': scope },
  });
}

let app: Hono;

// The route stack derives cursor expiry from the mocked snapshot
// (2026-07-14T12:00Z + 24h) but decodePartnerExportCursor checks expiry
// against the wall clock. Pin Date (and only Date) so cursor round-trips
// stay inside the snapshot's validity window regardless of when the suite
// runs.
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-07-14T12:30:00.000Z'), toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('partner desired-configuration exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleOrgIds = [ORG_A, ORG_B];
    mocks.queryResults = [];
    mocks.execute.mockImplementation(async () => {
      if (mocks.execute.mock.calls.length % 2 === 1) {
        return [{ snapshotAt: new Date('2026-07-14T12:00:00.000Z') }];
      }
      const result = mocks.queryResults.shift() ?? [];
      if (result instanceof Error) throw result;
      return result;
    });
    app = new Hono().route('/partner-api', partnerApiRoutes);
  });

  it.each(ROUTES)('requires authentication and exact scope for %s', async (path, scope) => {
    expect((await request(path, scope, 'missing')).status).toBe(401);
    expect((await request(path, 'organizations:read')).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('rejects invalid queries before database work for %s', async (path, scope) => {
    for (const suffix of ['?orgId=nope', '?siteId=11111111-1111-4111-8111-111111111111', '?limit=0', '?updatedSince=nope', '?cursor=nope']) {
      expect((await request(`${path}${suffix}`, scope)).status).toBe(400);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('returns a schema-valid empty envelope and locks before selecting %s', async (path, scope, schema) => {
    mocks.queryResults.push([]);
    const response = await request(path, scope);
    expect(response.status).toBe(200);
    expect(schema.parse(await response.json())).toMatchObject({
      schemaVersion: '1', data: [], nextCursor: null, hasMore: false,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('exports policy definitions and distinct assignment records', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization', name: 'Server baseline', description: 'Durable desired state',
      status: 'active', features: [{ id: SOURCE_B, type: 'patch', policyId: null, settings: patchMaterial() }],
    })]);
    const policy = await (await request('/configuration-policies', 'configuration:read')).json();
    expect(configurationPolicyExportEnvelopeSchema.parse(policy).data[0]).toMatchObject({
      id: SOURCE_A, orgId: ORG_A, sourceScope: 'organization', name: 'Server baseline',
      features: [{ id: SOURCE_B, type: 'patch', settings: { rebootPolicy: 'if_required' } }],
    });
    const policyQuery = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1]![0]).sql.toLowerCase();
    expect(policyQuery).toContain('breeze_partner_export_effective_policy_settings');

    mocks.queryResults.push([row(SOURCE_B, ORG_A, {
      policyId: SOURCE_A, policyName: 'Server baseline', sourceScope: 'organization', level: 'site',
      targetId: '77777777-7777-4777-8777-777777777777', priority: 10,
      roleFilter: ['server'], osFilter: ['windows'],
    })]);
    const assignment = await (await request('/configuration-assignments', 'configuration:read')).json();
    expect(configurationAssignmentExportEnvelopeSchema.parse(assignment).data[0]).toMatchObject({
      id: SOURCE_B, orgId: ORG_A, policyId: SOURCE_A, level: 'site', roleFilter: ['server'],
    });
  });

  it('canonicalizes the internal patch mirror before safety inspection or DTO assembly', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization',
      name: 'Canonical patch policy',
      description: null,
      status: 'active',
      features: [{
        id: SOURCE_B,
        type: 'patch',
        policyId: null,
        settings: patchMaterial({
            autoApproveDeferralDays: 7,
            apps: [{ source: 'third_party', packageId: 'Example.App', action: 'block' }],
            password: 'hunter2',
        }),
      }],
    })]);

    const response = await request('/configuration-policies', 'configuration:read');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.blocked).toBeUndefined();
    expect(body.data[0].features[0].settings).toEqual({
      ...NORMALIZED_PATCH_FACTS,
      autoApproveDeferralDays: 7,
      apps: [{ source: 'third_party', packageId: 'Example.App', action: 'block' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/__breezePatchInlineMirror|hunter2/u);

    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization',
      name: 'Canonical patch policy',
      description: null,
      status: 'active',
      features: [{
        id: SOURCE_B,
        type: 'patch',
        policyId: null,
        settings: patchMaterial({
            autoApproveDeferralDays: 7,
            apps: [{ action: 'block' }],
            apiKey: 'sk-live-never-export',
        }),
      }],
    })]);
    const invalidBody = await (await request('/configuration-policies', 'configuration:read')).json();
    expect(invalidBody.blocked).toBeUndefined();
    expect(invalidBody.data[0].features[0].settings).toEqual({
      ...NORMALIZED_PATCH_FACTS,
      autoApproveDeferralDays: 0,
      apps: [],
    });
    expect(JSON.stringify(invalidBody)).not.toMatch(/__breezePatchInlineMirror|sk-live-never-export/u);
  });

  it.each([
    'security', 'software_policy', 'peripheral_control',
    'warranty', 'helper', 'vulnerability',
  ] as const)('blocks a whole %s policy when an existing row contains the reserved marker', async (featureType) => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization',
      name: 'Unsafe policy',
      description: null,
      status: 'active',
      features: [{
        id: SOURCE_B,
        type: featureType,
        policyId: null,
        settings: { nested: { [PATCH_INLINE_MIRROR_MATERIAL]: 'attacker-value' } },
      }],
    })]);

    const response = await request('/configuration-policies', 'configuration:read');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([{
      resource: 'configuration-policies',
      id: SOURCE_A,
      orgId: ORG_A,
      reason: 'secret_detected',
      fieldPaths: ['features'],
    }]);
    expect(JSON.stringify(body)).not.toMatch(/__breezePatchInlineMirror|attacker-value/u);
  });

  it('blocks an attacker collision nested inside otherwise valid patch mirror material', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization',
      name: 'Unsafe patch policy',
      description: null,
      status: 'active',
      features: [{
        id: SOURCE_B,
        type: 'patch',
        policyId: null,
        settings: patchMaterial({
          nested: { [PATCH_INLINE_MIRROR_MATERIAL]: 'collision-secret' },
        }),
      }],
    })]);

    const body = await (await request('/configuration-policies', 'configuration:read')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'configuration-policies', id: SOURCE_A, orgId: ORG_A,
      reason: 'secret_detected', fieldPaths: ['features'],
    })]);
    expect(JSON.stringify(body)).not.toMatch(/__breezePatchInlineMirror|collision-secret/u);
  });

  it('blocks malformed non-array feature material before revision hashing', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization',
      name: 'Malformed features policy',
      description: null,
      status: 'active',
      features: {
        nested: { [PATCH_INLINE_MIRROR_MATERIAL]: 'non-array-collision' },
      },
    })]);

    const body = await (await request('/configuration-policies', 'configuration:read')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'configuration-policies', id: SOURCE_A, orgId: ORG_A,
      reason: 'secret_detected', fieldPaths: ['features'],
    })]);
    expect(JSON.stringify(body)).not.toMatch(/__breezePatchInlineMirror|non-array-collision/u);
  });

  it.each([
    ['non-object settings', 'malformed-patch-material'],
    ['missing mirror material', NORMALIZED_PATCH_FACTS],
    ['missing normalized child', {
      ...NORMALIZED_PATCH_FACTS,
      scheduleTime: undefined,
      [PATCH_INLINE_MIRROR_MATERIAL]: {},
    }],
  ] as const)('blocks patch rows with %s before revision or DTO assembly', async (_name, settings) => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization',
      name: 'Malformed patch policy',
      description: null,
      status: 'active',
      features: [{ id: SOURCE_B, type: 'patch', policyId: null, settings }],
    })]);

    const body = await (await request('/configuration-policies', 'configuration:read')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'configuration-policies', id: SOURCE_A, orgId: ORG_A,
      reason: 'secret_detected', fieldPaths: ['features'],
    })]);
    expect(JSON.stringify(body)).not.toContain(PATCH_INLINE_MIRROR_MATERIAL);
  });

  it('exports a complete rebuild-safe script with parameters or blocks the whole script', async () => {
    const definition = {
      sourceScope: 'partner', name: 'Install database', description: 'Rebuild procedure', category: 'build',
      osTypes: ['linux'], language: 'bash', content: 'dnf install postgresql17',
      parameters: [{ name: 'clusterName', type: 'string', required: true }], timeoutSeconds: 900,
      runAs: 'elevated', version: 4, exitCodeSeverityMapping: { '0': null, '1': 'high' },
    };
    mocks.queryResults.push([row(SOURCE_A, ORG_A, definition)]);
    const safe = await (await request('/scripts', 'scripts:read')).json();
    expect(scriptExportEnvelopeSchema.parse(safe).data[0]).toMatchObject(definition);

    const secret = `sk-live-${'A1b2C3d4'.repeat(6)}`;
    mocks.queryResults.push([row(SOURCE_A, ORG_A, { ...definition, content: `export TOKEN=${secret}` })]);
    const blocked = await (await request('/scripts', 'scripts:read')).json();
    expect(blocked.data).toEqual([]);
    expect(blocked.blocked).toEqual([expect.objectContaining({
      resource: 'scripts', id: SOURCE_A, orgId: ORG_A, reason: 'secret_detected',
    })]);
    expect(JSON.stringify(blocked)).not.toContain(secret);
    expect(JSON.stringify(blocked)).not.toContain('dnf install');
  });

  it.each([
    'password=hunter2',
    'DB_PASSWORD=hunter2',
    'LOCAL_ADMIN_PASSWORD=Summer2026!',
    'set "PASSWORD=hunter2"',
    'setx PASSWORD hunter2',
    'setx DB_PASSWORD hunter2',
    'setx /M DB_PASSWORD hunter2',
    '{"password":"hunter2"}',
    '{"DB_PASSWORD": "hunter2"}',
    "$Password = 'Summer2026!'",
    "ConvertTo-SecureString 'Summer2026!' -AsPlainText -Force",
    "ConvertTo-SecureString -String 'Summer2026!' -AsPlainText -Force",
    "ConvertTo-SecureString -AsPlainText -Force -String 'Summer2026!'",
    'DATABASE_URL=postgres://admin:hunter2@db.example/app',
    'RECOVERY_KEY=ABC-123',
    'PASSWORD_VALUE=hunter2',
    'TOKEN_BACKUP=hunter2',
    'echo "PASSWORD=hunter2"',
    'mysql --password=hunter2',
    'tool --password hunter2',
    'tool --api-key hunter2',
    'pwsh -Password hunter2',
  ])('blocks the whole script for low-entropy credential syntax without leaking derived metadata: %s', async (content) => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization', name: 'Unsafe rebuild', description: null, category: 'build',
      osTypes: ['windows'], language: 'powershell', content, parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    })]);
    const body = await (await request('/scripts', 'scripts:read')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'scripts', id: SOURCE_A, orgId: ORG_A, reason: 'secret_detected',
    })]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(content);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Summer2026');
  });

  it('fails closed when script tokenization reaches its bounded inspection budget', async () => {
    const content = `${'='.repeat(10_001)}PASSWORD=hunter2`;
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'organization', name: 'Unsafe rebuild', description: null, category: 'build',
      osTypes: ['windows'], language: 'powershell', content, parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    })]);
    const body = await (await request('/scripts', 'scripts:read')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'scripts', id: SOURCE_A, orgId: ORG_A, reason: 'secret_detected',
    })]);
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('exports automation steps and stable script dependencies without run state', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'partner', name: 'Rebuild application', description: null, enabled: true,
      trigger: { type: 'manual' }, conditions: null,
      actions: [{ type: 'run_script', scriptId: SOURCE_B }, { type: 'reboot' }],
      onFailure: 'stop', notificationTargets: null, dependencies: [{ resource: 'scripts', id: SOURCE_B }],
    })]);
    const body = await (await request('/automations', 'configuration:read')).json();
    expect(automationExportEnvelopeSchema.parse(body).data[0]).toMatchObject({
      actions: [{ type: 'run_script', scriptId: SOURCE_B }, { type: 'reboot' }],
      dependencies: [{ resource: 'scripts', id: SOURCE_B }],
    });
    expect(JSON.stringify(body)).not.toMatch(/lastRunAt|runCount|logs|output/);
    const renderedQuery = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1]![0]).sql.toLowerCase();
    expect(renderedQuery).toContain('eo.material_updated_at as updated_at');
    expect(renderedQuery).not.toContain('greatest(a.updated_at');
  });

  it('exports real backup metadata and explicitly reports the missing durable restore procedure', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      kind: 'destination', sourceScope: 'organization', name: 'Primary offsite', type: 'system_image',
      provider: 's3', compression: true, encryption: true, active: true, default: true,
      schedule: { cron: '0 2 * * *', timezone: 'America/Denver' },
      retention: { daily: 14, monthly: 12 }, exclusions: ['/var/cache'],
      completenessGaps: [{ code: 'restore_procedure_unavailable' }],
    })]);
    const body = await (await request('/backup-configurations', 'backup-configuration:read')).json();
    expect(backupConfigurationExportEnvelopeSchema.parse(body).data[0]).toMatchObject({
      kind: 'destination', provider: 's3', retention: { daily: 14, monthly: 12 },
      exclusions: ['/var/cache'], completenessGaps: [{ code: 'restore_procedure_unavailable' }],
    });
    const renderedQuery = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1]![0]).sql.toLowerCase();
    for (const forbidden of ['provider_config', 'encryption_key', 'backup_jobs', 'backup_snapshots', 'restore_jobs']) {
      expect(renderedQuery).not.toContain(forbidden);
    }
    expect(renderedQuery).not.toContain('greatest(bc.updated_at');
    expect(renderedQuery).not.toContain('greatest(bp.updated_at');
    expect(renderedQuery).not.toContain('greatest(pol.updated_at');
  });

  it('exports custom-field definitions without embedding a permanently truncated value collection', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'partner', name: 'Rack', fieldKey: 'rack', type: 'text', options: null,
      required: false, defaultValue: null, deviceTypes: ['server'],
    })]);
    const body = await (await request('/custom-fields', 'custom-fields:read')).json();
    expect(customFieldExportEnvelopeSchema.parse(body).data[0]).toMatchObject({
      id: SOURCE_A, orgId: ORG_A, fieldKey: 'rack',
    });
    expect(body.data[0]).not.toHaveProperty('values');
    expect(body.data[0]).not.toHaveProperty('valueCollection');
  });

  it('blocks a secret-semantic custom definition and value without leaking the value or its hash', async () => {
    const secretValue = 'Summer2026!';
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'partner', name: 'local_admin_password', fieldKey: 'local_admin_password',
      type: 'text', options: null, required: false, defaultValue: null, deviceTypes: ['server'],
      exampleValue: secretValue,
    })]);
    const body = await (await request('/custom-fields', 'custom-fields:read')).json();
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({
      resource: 'custom-fields', id: SOURCE_A, orgId: ORG_A, reason: 'secret_detected',
    })]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain('local_admin_password');
    expect(serialized).not.toContain('Summer2026');
  });

  it('pages more than 500 values on one device without duplicate or skipped definition identities', async () => {
    const firstPage = Array.from({ length: 501 }, (_, index) => row(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      ORG_A,
      {
        siteId: null,
        deviceId: DEVICE_ID,
        definitionId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        target: { type: 'device', id: DEVICE_ID },
        name: `Field ${index}`,
        fieldKey: `field_${index}`,
        type: 'text',
        value: `value-${index}`,
      },
    ));
    mocks.queryResults.push(firstPage);
    const first = await (await request('/custom-field-values?limit=500', 'custom-fields:read')).json();
    expect(customFieldValueExportEnvelopeSchema.parse(first)).toMatchObject({ hasMore: true });
    expect(first.data).toHaveLength(500);

    mocks.queryResults.push([firstPage[500]!]);
    const second = await (await request(
      `/custom-field-values?limit=500&cursor=${encodeURIComponent(first.nextCursor)}`,
      'custom-fields:read',
    )).json();
    expect(customFieldValueExportEnvelopeSchema.parse(second)).toMatchObject({ hasMore: false });
    const ids = [...first.data, ...second.data].map((record) => `${record.id}:${record.orgId}`);
    expect(ids).toHaveLength(501);
    expect(new Set(ids).size).toBe(501);
    expect(new Set([...first.data, ...second.data].map((record) => record.definitionId)).size).toBe(501);
    expect([...first.data, ...second.data].every((record) => record.deviceId === DEVICE_ID)).toBe(true);
  });

  it('fans partner definitions out with stable composite pagination identity', async () => {
    const definition = {
      sourceScope: 'partner', name: 'Inventory label', fieldKey: 'inventory_label', type: 'text',
      options: null, required: false, defaultValue: null, deviceTypes: null,
    };
    mocks.queryResults.push([row(SOURCE_A, ORG_A, definition), row(SOURCE_A, ORG_B, definition)]);
    const first = await (await request('/custom-fields?limit=1', 'custom-fields:read')).json();
    expect(first).toMatchObject({ hasMore: true, data: [expect.objectContaining({ id: SOURCE_A, orgId: ORG_A })] });
    expect(first.nextCursor).toEqual(expect.any(String));

    mocks.queryResults.push([row(SOURCE_A, ORG_B, definition)]);
    const second = await (await request(
      `/custom-fields?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      'custom-fields:read',
    )).json();
    expect(second).toMatchObject({ hasMore: false, snapshotAt: first.snapshotAt });
    expect(second.data[0]).toMatchObject({ id: SOURCE_A, orgId: ORG_B });
  });

  it.each(ROUTES)('supports stable incremental traversal for %s', async (path, scope, schema) => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, sampleDefinition(path))]);
    const response = await request(`${path}?updatedSince=${encodeURIComponent('2026-07-11T00:00:00.000Z')}`, scope);
    expect(response.status).toBe(200);
    expect(schema.parse(await response.json()).data).toHaveLength(1);
  });

  it.each(ROUTES)('fails closed for inaccessible/nonexistent org filters on %s', async (path, scope) => {
    expect((await request(`${path}?orgId=${OTHER_ORG}`, scope)).status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('returns a bounded error without query leakage for %s', async (path, scope) => {
    mocks.queryResults.push(new Error('postgresql://operator:secret@internal/private'));
    const response = await request(path, scope);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/operator|secret|internal/);
  });
});

function sampleDefinition(path: string): Record<string, unknown> {
  switch (path) {
    case '/configuration-policies':
      return { sourceScope: 'organization', name: 'P', description: null, status: 'active', features: [] };
    case '/configuration-assignments':
      return { policyId: SOURCE_B, policyName: 'P', sourceScope: 'organization', level: 'organization', targetId: ORG_A, priority: 0, roleFilter: null, osFilter: null };
    case '/scripts':
      return { sourceScope: 'organization', name: 'S', description: null, category: null, osTypes: ['linux'], language: 'bash', content: 'true', parameters: null, timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null };
    case '/automations':
      return { sourceScope: 'organization', name: 'A', description: null, enabled: true, trigger: { type: 'manual' }, conditions: null, actions: [{ type: 'reboot' }], onFailure: 'stop', notificationTargets: null, dependencies: [] };
    case '/backup-configurations':
      return { kind: 'profile', sourceScope: 'organization', name: 'B', description: null, active: true, selections: {}, destinationId: null, schedule: null, retention: null, exclusions: [], completenessGaps: [{ code: 'restore_procedure_unavailable' }] };
    case '/custom-field-values':
      return { deviceId: DEVICE_ID, definitionId: SOURCE_A, target: { type: 'device', id: DEVICE_ID }, name: 'C', fieldKey: 'c', type: 'text', value: 'safe' };
    default:
      return { sourceScope: 'organization', name: 'C', fieldKey: 'c', type: 'text', options: null, required: false, defaultValue: null, deviceTypes: null };
  }
}
