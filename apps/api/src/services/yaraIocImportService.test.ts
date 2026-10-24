/**
 * W04 IOC import service (#6263 W04-1, extracted by #6268 for the AI path).
 * The route keeps its own suite (routes/security/yaraIocImport.test.ts);
 * here: the gates, and the AI-only auto-quarantine refusal under the set lock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, selectMock, insertMock, publishMock, partnerWideMock, siteCeilingMock } = vi.hoisted(() => ({
  calls: [] as string[],
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  publishMock: vi.fn(),
  partnerWideMock: vi.fn(() => true),
  siteCeilingMock: vi.fn(() => true),
}));

vi.mock('../db', () => ({
  db: { select: selectMock, insert: insertMock },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./yaraRuleSetPublisher', () => ({ publishRuleSet: publishMock }));
vi.mock('./partnerWideAccess', () => ({
  canManagePartnerWidePolicies: partnerWideMock,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'partner-wide denied',
}));
vi.mock('./siteCeilingAccess', () => ({
  canMutateOrgWideGovernance: siteCeilingMock,
  SITE_CEILING_WRITE_DENIED_MESSAGE: 'site ceiling denied',
}));

import type { AuthContext } from '../middleware/auth';
import { AI_IMPORT_AUTO_QUARANTINE_SET, importIocsIntoSet } from './yaraIocImportService';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const auth = {
  scope: 'organization', orgId: ORG, partnerId: 'p-1', user: { id: 'u-1' },
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
} as unknown as AuthContext;
const orgSet = { id: SET, orgId: ORG, partnerId: null, isBuiltin: false, name: 'Advisories', autoQuarantine: false };
const MD5 = 'f'.repeat(32);
const ALLOW = { autoQuarantine: 'allow' } as const;
const input = { label: 'Advisory 7', iocs: [{ kind: 'md5' as const, value: MD5 }, { kind: 'domain' as const, value: 'bad.example' }] };

/** The queries in call order: visible set, FOR UPDATE lock, existing names, count. */
function queue(opts: { visible?: Record<string, unknown> | null; locked?: Record<string, unknown> | null; existing?: unknown[]; count?: number }) {
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => { calls.push('visible'); return Promise.resolve(opts.visible === null ? [] : [opts.visible ?? orgSet]); } }) }),
  });
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ for: (mode: string) => { calls.push(`lock:${mode}`); return Promise.resolve(opts.locked === null ? [] : [opts.locked ?? { id: SET, autoQuarantine: false }]); } }) }),
  });
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => { calls.push('existing'); return Promise.resolve(opts.existing ?? []); } }),
  });
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => { calls.push('count'); return Promise.resolve([{ value: opts.count ?? 0 }]); } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  calls.length = 0;
  partnerWideMock.mockReturnValue(true);
  siteCeilingMock.mockReturnValue(true);
  insertMock.mockReturnValue({
    values: (rows: Array<{ name: string }>) => ({
      returning: () => { calls.push('insert'); return Promise.resolve(rows.map((r, i) => ({ id: `r-${i}`, name: r.name }))); },
    }),
  });
  publishMock.mockResolvedValue({ published: true, version: 4, currentVersion: 4, stale: false, errors: [] });
});

describe('importIocsIntoSet', () => {
  it('imports, publishes and returns the route body plus an audit event with no IOC value', async () => {
    queue({});
    const out = await importIocsIntoSet(auth, SET, input, ALLOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.status).toBe(201);
    expect(out.body.publish).toEqual({ published: true, version: 4, currentVersion: 4, stale: false, errors: [] });
    expect(out.body.data.rules).toHaveLength(2);
    expect(out.audit).toMatchObject({ action: 'security.yara_rule.ioc_import', orgId: ORG, resourceId: SET, details: { iocCount: 2, kinds: { md5: 1, domain: 1 } } });
    expect(JSON.stringify(out.audit)).not.toContain(MD5);
    expect(JSON.stringify(out.audit)).not.toContain('bad.example');
    expect(calls).toEqual(['visible', 'lock:update', 'existing', 'count', 'insert']);
    expect(publishMock).toHaveBeenCalledWith(SET);
  });

  it('AI path: an auto-quarantine set is refused AFTER the FOR UPDATE lock and before any insert', async () => {
    queue({ locked: { id: SET, autoQuarantine: true } });
    const out = await importIocsIntoSet(auth, SET, input, { autoQuarantine: 'refuse' });
    expect(out).toMatchObject({ ok: false, status: 409, body: { code: AI_IMPORT_AUTO_QUARANTINE_SET } });
    expect(calls).toEqual(['visible', 'lock:update']);
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('decides on the LOCKED row, not the pre-lock read: a set flipped on before the lock is refused', async () => {
    queue({ visible: { ...orgSet, autoQuarantine: false }, locked: { id: SET, autoQuarantine: true } });
    expect(await importIocsIntoSet(auth, SET, input, { autoQuarantine: 'refuse' })).toMatchObject({ status: 409, body: { code: AI_IMPORT_AUTO_QUARANTINE_SET } });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('the route path (no option) imports into an auto-quarantine set as W04 always did', async () => {
    queue({ locked: { id: SET, autoQuarantine: true } });
    expect(await importIocsIntoSet(auth, SET, input, ALLOW)).toMatchObject({ ok: true, status: 201 });
  });

  it('built-in → 403; partner-wide without canManagePartnerWidePolicies → 403; site ceiling → 403', async () => {
    queue({ visible: { ...orgSet, isBuiltin: true, orgId: null } });
    expect(await importIocsIntoSet(auth, SET, input, { autoQuarantine: 'refuse' })).toMatchObject({ status: 403, body: { error: 'The built-in rule set is read-only' } });

    selectMock.mockReset();
    partnerWideMock.mockReturnValue(false);
    queue({ visible: { ...orgSet, orgId: null, partnerId: 'p-1' } });
    expect(await importIocsIntoSet(auth, SET, input, { autoQuarantine: 'refuse' })).toMatchObject({ status: 403, body: { error: 'partner-wide denied' } });

    selectMock.mockReset();
    partnerWideMock.mockReturnValue(true);
    siteCeilingMock.mockReturnValue(false);
    queue({});
    expect(await importIocsIntoSet(auth, SET, input, { autoQuarantine: 'refuse' })).toMatchObject({ status: 403, body: { error: 'site ceiling denied' } });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('unknown set → 404; invalid IOC → 400 IOC_INVALID; cap → 400; identical batch → 409', async () => {
    queue({ visible: null });
    expect(await importIocsIntoSet(auth, SET, input, ALLOW)).toEqual({ ok: false, status: 404, body: { error: 'Rule set not found' } });

    selectMock.mockReset();
    queue({});
    expect(await importIocsIntoSet(auth, SET, { label: 'x', iocs: [{ kind: 'md5', value: 'not-a-hash' }] }, ALLOW)).toMatchObject({ status: 400, body: { code: 'IOC_INVALID' } });

    selectMock.mockReset();
    queue({ count: 499 });
    expect(await importIocsIntoSet(auth, SET, input, ALLOW)).toMatchObject({ status: 400, body: { code: 'IOC_TOO_MANY_RULES' } });
  });
});
