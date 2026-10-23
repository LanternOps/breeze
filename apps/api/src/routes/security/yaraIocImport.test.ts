/**
 * POST /security/yara/rule-sets/:id/ioc-import (#6263 W04-1). Gates, the
 * server-side re-generation, collisions and the lock-before-count order are
 * pinned here with a mocked query builder; real RLS and the concurrent
 * 498-rule race are in __tests__/integration/yaraW04Routes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { generateIocRules, YARA_IOC_MAX_PER_BATCH, YARA_IOC_VALUE_MAX_CHARS } from '@breeze/shared';

const { insertMock, selectMock, publishMock, getUserPermissionsMock, auditMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  selectMock: vi.fn(),
  publishMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { insert: insertMock, select: selectMock, update: vi.fn(), delete: vi.fn() },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../services/auditEvents', async () => {
  const actual = await vi.importActual<any>('../../services/auditEvents');
  return { ...actual, writeRouteAudit: auditMock };
});
vi.mock('../../services/yaraRuleSetPublisher', () => ({ publishRuleSet: publishMock }));

import { yaraIocImportRoutes } from './yaraIocImport';
import { bodyLimitForPath } from '../../middleware/bodyLimit';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const PUBLISHED = { published: true, version: 3, currentVersion: 3, stale: false, errors: [] };

function app(auth: Record<string, unknown> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: 'p-1', accessibleOrgIds: [ORG],
      user: { id: 'u-1', email: 'u@example.test' },
      canAccessOrg: (id: string) => id === ORG,
      orgCondition: () => undefined,
      ...auth,
    } as any);
    await next();
  });
  a.route('/security', yaraIocImportRoutes);
  return a;
}

const post = (a: Hono, body: unknown) =>
  a.request(`/security/yara/rule-sets/${SET}/ioc-import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

const orgSet = { id: SET, orgId: ORG, partnerId: null, isBuiltin: false, name: 'Advisories', enabled: true, currentVersion: 2 };

function mockVisibleSet(row: Record<string, unknown> | null) {
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
  });
}

/** lock → existing-name lookup → count, recording the order they ran in. */
function mockLockedPhase(order: string[], opts: { existing?: Array<{ name: string; source: string }>; count?: number } = {}) {
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ for: (mode: string) => { order.push(`lock:${mode}`); return Promise.resolve([{ id: SET }]); } }) }),
  });
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => { order.push('names'); return Promise.resolve(opts.existing ?? []); } }),
  });
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => { order.push('count'); return Promise.resolve([{ value: opts.count ?? 0 }]); } }),
  });
}

function mockInsert() {
  const values = vi.fn((rows: Array<Record<string, unknown>>) => ({
    returning: () => Promise.resolve(rows.map((r, i) => ({ id: `rule-${i}`, name: r.name as string }))),
  }));
  insertMock.mockReturnValueOnce({ values });
  return values;
}

const body = {
  label: 'ACME Advisory 7',
  iocs: [
    { kind: 'sha256', value: SHA_A },
    { kind: 'sha256', value: SHA_B },
    { kind: 'domain', value: 'evil[.]example.com' },
    { kind: 'string', value: 'secret-marker-value' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  insertMock.mockReset();
  getUserPermissionsMock.mockResolvedValue({
    permissions: [{ resource: 'devices', action: 'write' }, { resource: 'devices', action: 'read' }],
    partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization',
  });
  publishMock.mockResolvedValue(PUBLISHED);
});

describe('POST /yara/rule-sets/:id/ioc-import — gates', () => {
  it('404s a set the caller cannot see', async () => {
    mockVisibleSet(null);
    const res = await post(app(), body);
    expect(res.status).toBe(404);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('403s the built-in set', async () => {
    mockVisibleSet({ ...orgSet, orgId: null, isBuiltin: true });
    const res = await post(app(), body);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('The built-in rule set is read-only');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('403s a partner-wide set without canManagePartnerWidePolicies', async () => {
    mockVisibleSet({ ...orgSet, orgId: null, partnerId: 'p-1' });
    const res = await post(app(), body);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('403s a site-restricted caller', async () => {
    mockVisibleSet(orgSet);
    const res = await post(app({ allowedSiteIds: ['33333333-3333-4333-8333-333333333333'] }), body);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('403s without devices:write', async () => {
    getUserPermissionsMock.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'read' }], partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization' });
    const res = await post(app(), body);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 IOC_INVALID lists every bad IOC by index, before any lock or insert', async () => {
    mockVisibleSet(orgSet);
    const res = await post(app(), {
      label: 'x',
      iocs: [{ kind: 'md5', value: 'zz' }, { kind: 'domain', value: 'ok.example.com' }, { kind: 'domain', value: 'OK.example.com' }],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('IOC_INVALID');
    expect(json.errors).toEqual([{ index: 0, code: 'bad_hash' }, { index: 2, code: 'duplicate' }]);
    expect(JSON.stringify(json)).not.toContain('ok.example.com'); // indexes and codes only — never the IOC values
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects client rule text: the schema is strict', async () => {
    const res = await post(app(), { ...body, source: 'rule x { condition: true }' });
    expect(res.status).toBe(400);
    const nested = await post(app(), { label: 'x', iocs: [{ kind: 'string', value: 'abcd', source: 'rule' }] });
    expect(nested.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects more than 1000 IOCs and over-long values in the schema', async () => {
    const many = Array.from({ length: YARA_IOC_MAX_PER_BATCH + 1 }, (_, i) => ({ kind: 'string', value: `marker-${i}` }));
    expect((await post(app(), { label: 'x', iocs: many })).status).toBe(400);
    expect((await post(app(), { label: 'x', iocs: [{ kind: 'string', value: 'x'.repeat(YARA_IOC_VALUE_MAX_CHARS + 1) }] })).status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('a 1000-IOC body at the per-value max fits the default body limit', () => {
    const iocs = Array.from({ length: YARA_IOC_MAX_PER_BATCH }, () => ({ kind: 'filepath', value: `C:\\${'a'.repeat(YARA_IOC_VALUE_MAX_CHARS - 3)}` }));
    const size = Buffer.byteLength(JSON.stringify({ label: 'x'.repeat(64), severity: 'critical', iocs }));
    const limit = bodyLimitForPath(`/api/v1/security/yara/rule-sets/${SET}/ioc-import`);
    expect(limit.rule).toBe('default');
    expect(size).toBeLessThan(limit.maxSize);
  });
});

describe('POST /yara/rule-sets/:id/ioc-import — writes', () => {
  it('locks the set BEFORE looking up names and counting, then inserts the generated rules and publishes once', async () => {
    const order: string[] = [];
    mockVisibleSet(orgSet);
    mockLockedPhase(order, { count: 10 });
    const values = mockInsert();

    const res = await post(app(), body);
    expect(res.status).toBe(201);
    expect(order).toEqual(['lock:update', 'names', 'count']);

    const expected = generateIocRules({ label: body.label, iocs: body.iocs as any });
    const inserted = values.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(expected.length);
    inserted.forEach((row, i) => {
      expect(row).toEqual({
        ruleSetId: SET,
        name: expected[i]!.name,
        source: expected[i]!.source,
        severity: 'high',
        tags: expected[i]!.tags,
        enabled: true,
      });
    });
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(SET);

    const json = await res.json();
    expect(json.publish).toEqual(PUBLISHED);
    expect(json.data.rules).toEqual(expected.map((r, i) => ({ id: `rule-${i}`, name: r.name, kind: r.kind, iocCount: r.iocCount })));
  });

  it('honours the requested severity', async () => {
    mockVisibleSet(orgSet);
    mockLockedPhase([]);
    const values = mockInsert();
    const res = await post(app(), { ...body, severity: 'critical' });
    expect(res.status).toBe(201);
    for (const row of values.mock.calls[0]![0] as Array<{ severity: string }>) expect(row.severity).toBe('critical');
  });

  it('400 IOC_TOO_MANY_RULES when existing + generated exceeds 500', async () => {
    mockVisibleSet(orgSet);
    mockLockedPhase([], { count: 499 });
    const res = await post(app(), { label: 'x', iocs: [{ kind: 'md5', value: 'a'.repeat(32) }, { kind: 'domain', value: 'evil.example.com' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('IOC_TOO_MANY_RULES');
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('409 IOC_BATCH_ALREADY_IMPORTED when every colliding name holds the identical source', async () => {
    const [rule] = generateIocRules({ label: 'x', iocs: [{ kind: 'domain', value: 'evil.example.com' }] });
    mockVisibleSet(orgSet);
    mockLockedPhase([], { existing: [{ name: rule!.name, source: rule!.source }] });
    const res = await post(app(), { label: 'x', iocs: [{ kind: 'domain', value: 'evil.example.com' }] });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('IOC_BATCH_ALREADY_IMPORTED');
    expect(json.names).toEqual([rule!.name]);
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('409 IOC_RULE_NAME_TAKEN when a colliding name holds different source', async () => {
    const [rule] = generateIocRules({ label: 'x', iocs: [{ kind: 'domain', value: 'evil.example.com' }] });
    mockVisibleSet(orgSet);
    mockLockedPhase([], { existing: [{ name: rule!.name, source: 'rule edited { condition: true }' }] });
    const res = await post(app(), { label: 'x', iocs: [{ kind: 'domain', value: 'evil.example.com' }] });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('IOC_RULE_NAME_TAKEN');
    expect(json.names).toEqual([rule!.name]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('a unique violation at insert (a racing import) is a 409, not a 500', async () => {
    mockVisibleSet(orgSet);
    mockLockedPhase([]);
    insertMock.mockReturnValueOnce({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505', constraint: 'yara_rules_set_name_uniq' })),
      }),
    });
    const res = await post(app(), body);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('IOC_RULE_NAME_TAKEN');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('a unique violation on any OTHER constraint is not reported as a name collision', async () => {
    mockVisibleSet(orgSet);
    mockLockedPhase([]);
    insertMock.mockReturnValueOnce({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505', constraint: 'some_other_uniq' })),
      }),
    });
    const res = await post(app(), body);
    expect(res.status).toBe(500);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('404s when the set vanished before the lock', async () => {
    mockVisibleSet(orgSet);
    selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => Promise.resolve([]) }) }) });
    const res = await post(app(), body);
    expect(res.status).toBe(404);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('audits ids and counts only — never an IOC value or the label', async () => {
    mockVisibleSet(orgSet);
    mockLockedPhase([]);
    mockInsert();
    const res = await post(app(), body);
    expect(res.status).toBe(201);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const event = auditMock.mock.calls[0]![1];
    expect(event.action).toBe('security.yara_rule.ioc_import');
    expect(event.resourceType).toBe('yara_rule_set');
    expect(event.resourceId).toBe(SET);
    expect(event.details).toEqual({
      ruleSetId: SET,
      ruleIds: ['rule-0', 'rule-1', 'rule-2'],
      kinds: { sha256: 2, domain: 1, string: 1 },
      iocCount: 4,
      published: true,
      version: 3,
      stale: false,
    });
    const serialized = JSON.stringify(event);
    for (const needle of [SHA_A, SHA_B, 'evil', 'secret-marker-value', 'ACME', 'acme']) {
      expect(serialized).not.toContain(needle);
    }
  });
});
