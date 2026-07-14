import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  scriptExportEnvelopeSchema,
} from './schemas';

const ROUTES = [
  ['/configuration-policies', 'configuration:read', configurationPolicyExportEnvelopeSchema],
  ['/configuration-assignments', 'configuration:read', configurationAssignmentExportEnvelopeSchema],
  ['/scripts', 'scripts:read', scriptExportEnvelopeSchema],
  ['/automations', 'configuration:read', automationExportEnvelopeSchema],
  ['/backup-configurations', 'backup-configuration:read', backupConfigurationExportEnvelopeSchema],
  ['/custom-fields', 'custom-fields:read', customFieldExportEnvelopeSchema],
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
      status: 'active', features: [{ id: SOURCE_B, type: 'patch', policyId: null, settings: { rebootPolicy: 'if_required' } }],
    })]);
    const policy = await (await request('/configuration-policies', 'configuration:read')).json();
    expect(configurationPolicyExportEnvelopeSchema.parse(policy).data[0]).toMatchObject({
      id: SOURCE_A, orgId: ORG_A, sourceScope: 'organization', name: 'Server baseline',
      features: [{ id: SOURCE_B, type: 'patch', settings: { rebootPolicy: 'if_required' } }],
    });

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
  });

  it('exports safe backup destination metadata, schedules, retention, exclusions, and restore capabilities', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      kind: 'destination', sourceScope: 'organization', name: 'Primary offsite', type: 'system_image',
      provider: 's3', compression: true, encryption: true, active: true, default: true,
      schedule: { cron: '0 2 * * *', timezone: 'America/Denver' },
      retention: { daily: 14, monthly: 12 }, exclusions: ['/var/cache'],
      restore: { types: ['full', 'selective', 'bare_metal'], notes: null },
    })]);
    const body = await (await request('/backup-configurations', 'backup-configuration:read')).json();
    expect(backupConfigurationExportEnvelopeSchema.parse(body).data[0]).toMatchObject({
      kind: 'destination', provider: 's3', retention: { daily: 14, monthly: 12 },
      exclusions: ['/var/cache'], restore: { types: ['full', 'selective', 'bare_metal'] },
    });
    const renderedQuery = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1]![0]).sql.toLowerCase();
    for (const forbidden of ['provider_config', 'encryption_key', 'backup_jobs', 'backup_snapshots', 'restore_jobs']) {
      expect(renderedQuery).not.toContain(forbidden);
    }
  });

  it('exports custom-field definitions and per-device values as one all-or-blocked definition', async () => {
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'partner', name: 'Rack', fieldKey: 'rack', type: 'text', options: null,
      required: false, defaultValue: null, deviceTypes: ['server'],
      values: [{ deviceId: DEVICE_ID, value: 'DC1-R07' }],
      valueCollection: { total: 1, included: 1, complete: true, reason: null },
    })]);
    const body = await (await request('/custom-fields', 'custom-fields:read')).json();
    expect(customFieldExportEnvelopeSchema.parse(body).data[0]).toMatchObject({
      id: SOURCE_A, orgId: ORG_A, fieldKey: 'rack', values: [{ deviceId: DEVICE_ID, value: 'DC1-R07' }],
    });
  });

  it('blocks a secret-semantic custom definition and value without leaking the value or its hash', async () => {
    const secretValue = 'Summer2026!';
    mocks.queryResults.push([row(SOURCE_A, ORG_A, {
      sourceScope: 'partner', name: 'local_admin_password', fieldKey: 'local_admin_password',
      type: 'text', options: null, required: false, defaultValue: null, deviceTypes: ['server'],
      values: [{ deviceId: DEVICE_ID, value: secretValue }],
      valueCollection: { total: 1, included: 1, complete: true, reason: null },
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

  it('fans partner definitions out with stable composite pagination identity', async () => {
    const definition = {
      sourceScope: 'partner', name: 'Inventory label', fieldKey: 'inventory_label', type: 'text',
      options: null, required: false, defaultValue: null, deviceTypes: null, values: [],
      valueCollection: { total: 0, included: 0, complete: true, reason: null },
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
      return { kind: 'profile', sourceScope: 'organization', name: 'B', description: null, active: true, selections: {}, destinationId: null, schedule: null, retention: null, exclusions: [], restore: { types: [], notes: null } };
    default:
      return { sourceScope: 'organization', name: 'C', fieldKey: 'c', type: 'text', options: null, required: false, defaultValue: null, deviceTypes: null, values: [], valueCollection: { total: 0, included: 0, complete: true, reason: null } };
  }
}
