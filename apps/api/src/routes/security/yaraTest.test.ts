/**
 * POST /security/yara/rule-sets/:id/test (#6263 W04-2). The runner
 * (services/yaraSampleMatch) is mocked: its framing, admission and exit
 * mapping are pinned in yaraSampleMatch.test.ts. Real-RLS tenancy is in
 * __tests__/integration/yaraW04Routes.integration.test.ts.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { buildYaraBundleJson, YARA_BUILTIN_RULE_SET_ID, YARA_TEST_SAMPLE_MAX_BYTES } from '@breeze/shared';

const m = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  auditMock: vi.fn(),
  reserveMock: vi.fn(),
  matchMock: vi.fn(),
  withAuthCtxMock: vi.fn(),
  // Filled once at import (route registration); never cleared.
  rateLimitArgs: [] as unknown[][],
}));

vi.mock('../../db', () => ({
  db: { insert: vi.fn(), select: m.selectMock, update: vi.fn(), delete: vi.fn() },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    withAuthDbAccessContext: (auth: unknown, fn: () => Promise<unknown>) => m.withAuthCtxMock(auth, fn),
  };
});

vi.mock('../../middleware/userRateLimit', () => ({
  userRateLimit: (...args: unknown[]) => {
    m.rateLimitArgs.push(args);
    return async (_c: any, next: any) => next();
  },
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: m.getUserPermissionsMock };
});

vi.mock('../../services/auditEvents', async () => {
  const actual = await vi.importActual<any>('../../services/auditEvents');
  return { ...actual, writeRouteAudit: m.auditMock };
});

vi.mock('../../services/yaraSampleMatch', () => ({
  reserveSampleMatch: m.reserveMock,
  matchSample: m.matchMock,
}));

import { YARA_TEST_BODY_READ_TIMEOUT_MS, yaraTestRoutes } from './yaraTest';
import { redactSecretsDeep } from '../../services/secretRedaction';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';

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
  a.route('/security', yaraTestRoutes);
  return a;
}

function post(a: Hono, body: BodyInit | null, query = 'filename=sample.bin', setId = SET) {
  return a.request(`/security/yara/rule-sets/${setId}/test?${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
  });
}

type Row = Record<string, unknown>;
const setRow: Row = {
  setId: SET, setOrgId: ORG, setPartnerId: null, setName: 'Org IOCs', isBuiltin: false, autoQuarantine: false,
  currentVersion: 4, publishedVersion: 3,
};
const ruleCols = { ruleId: RULE, ruleName: 'evil_mark', ruleSeverity: 'critical', ruleSource: 'rule evil_mark { strings: $a = "EVILMARK" condition: $a }' };

/** The one phase-1 statement: set LEFT JOIN enabled rules. */
function mockPhase1(rows: Row[], calls: string[] = []) {
  m.selectMock.mockReturnValueOnce({
    from: () => ({
      leftJoin: () => ({
        where: () => {
          calls.push('joined-select');
          return Promise.resolve(rows);
        },
      }),
    }),
  });
}

const reservation = { release: vi.fn() };
const SAMPLE = Buffer.from('xx EVILMARK xx');
const OK_RESULT = {
  ok: true, durationMs: 42, matches: [{
    ruleSetId: SET, ruleId: RULE, ruleName: 'evil_mark', severity: 'critical', tags: ['ioc'],
    matchedStrings: [{ id: '$a', offset: 3, data: 'EVILMARK' }],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.selectMock.mockReset();
  m.getUserPermissionsMock.mockResolvedValue({
    permissions: [{ resource: 'devices', action: 'write' }, { resource: 'devices', action: 'read' }],
    partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization',
  });
  m.withAuthCtxMock.mockImplementation(async (_auth: unknown, fn: () => Promise<unknown>) => fn());
  m.reserveMock.mockReturnValue(reservation);
  m.matchMock.mockResolvedValue(OK_RESULT);
});

describe('POST /yara/rule-sets/:id/test — gates', () => {
  it('registers the per-user rate limit yara-rule-test 10 / 600 s', () => {
    // The module registered its chain at import time.
    expect(m.rateLimitArgs).toContainEqual(['yara-rule-test', 10, 600]);
  });

  it('403 without devices:write, before any DB read', async () => {
    m.getUserPermissionsMock.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'read' }], partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization' });
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(403);
    expect(m.selectMock).not.toHaveBeenCalled();
    expect(m.matchMock).not.toHaveBeenCalled();
  });

  it('404 for a set the caller cannot see', async () => {
    mockPhase1([]);
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(404);
    expect(m.reserveMock).not.toHaveBeenCalled();
  });

  it('422 YARA_TEST_NO_RULES when the set has no enabled rules (LEFT JOIN row with null rule)', async () => {
    mockPhase1([{ ...setRow, ruleId: null, ruleName: null, ruleSeverity: null, ruleSource: null }]);
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('YARA_TEST_NO_RULES');
    expect(m.reserveMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing filename', ''],
    ['empty filename', 'filename='],
    ['a path, not a basename', 'filename=..%2Fx'],
    ['a dot-dot name', 'filename=..'],
    ['a control character', 'filename=a%00b'],
    ['an over-long filename', `filename=${'a'.repeat(256)}`],
    ['an over-long filepath', `filename=x&filepath=${'a'.repeat(1025)}`],
    ['a control character in filepath', 'filename=x&filepath=C%3A%5Ca%0Ab'],
  ])('400 for %s', async (_name, query) => {
    const res = await post(app(), SAMPLE, query);
    expect(res.status).toBe(400);
    expect(m.selectMock).not.toHaveBeenCalled();
  });

  it('400 for an empty body, and the reservation is released', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const res = await post(app(), new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(m.matchMock).not.toHaveBeenCalled();
    expect(reservation.release).toHaveBeenCalled();
  });
});

describe('POST /yara/rule-sets/:id/test — admission and size', () => {
  it('429 YARA_TEST_BUSY when no slot is free, without reading the body', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    m.reserveMock.mockReturnValueOnce(null);
    let pulled = false;
    // highWaterMark 0: the stream is pulled only when someone reads the body.
    const body = new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(SAMPLE));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const res = await app().request(`/security/yara/rule-sets/${SET}/test?filename=s.bin`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body, duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('YARA_TEST_BUSY');
    expect(pulled).toBe(false);
    expect(m.matchMock).not.toHaveBeenCalled();
  });

  it('408 YARA_TEST_BODY_TIMEOUT and the slot is released when the body never finishes arriving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockPhase1([{ ...setRow, ...ruleCols }]);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(SAMPLE)); // ...and never close
        },
      });
      const pending = app().request(`/security/yara/rule-sets/${SET}/test?filename=s.bin`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body, duplex: 'half',
      } as RequestInit);
      await vi.advanceTimersByTimeAsync(YARA_TEST_BODY_READ_TIMEOUT_MS + 1);
      const res = await pending;
      expect(res.status).toBe(408);
      expect((await res.json()).code).toBe('YARA_TEST_BODY_TIMEOUT');
      expect(reservation.release).toHaveBeenCalledTimes(1);
      expect(m.matchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a body of exactly YARA_TEST_SAMPLE_MAX_BYTES', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const res = await post(app(), new Uint8Array(YARA_TEST_SAMPLE_MAX_BYTES));
    expect(res.status).toBe(200);
    expect((m.matchMock.mock.calls[0]![1] as { sample: Buffer }).sample.length).toBe(YARA_TEST_SAMPLE_MAX_BYTES);
  });

  it('413 YARA_TEST_TOO_LARGE one byte over (the body-limit gate allows 64 KiB slack), and released', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const res = await post(app(), new Uint8Array(YARA_TEST_SAMPLE_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('YARA_TEST_TOO_LARGE');
    expect(m.matchMock).not.toHaveBeenCalled();
    expect(reservation.release).toHaveBeenCalled();
  });

  it('413 from a declared Content-Length before the body is read', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const res = await app().request(`/security/yara/rule-sets/${SET}/test?filename=s.bin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(YARA_TEST_SAMPLE_MAX_BYTES + 1) },
      body: SAMPLE,
    });
    expect(res.status).toBe(413);
    expect(m.reserveMock).not.toHaveBeenCalled();
  });
});

describe('POST /yara/rule-sets/:id/test — what is tested and what comes back', () => {
  it('tests the draft: one joined read in one short context, bundle at the current version, digest of those bytes', async () => {
    const calls: string[] = [];
    mockPhase1([
      { ...setRow, ...ruleCols },
      { ...setRow, ruleId: '44444444-4444-4444-8444-444444444444', ruleName: 'other', ruleSeverity: 'low', ruleSource: 'rule other { condition: false }' },
    ], calls);
    const res = await post(app(), SAMPLE, 'filename=invoice.pdf&filepath=C%3A%5CUsers%5CPublic%5Cinvoice.pdf');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['joined-select']);
    expect(m.withAuthCtxMock).toHaveBeenCalledTimes(1);

    const input = m.matchMock.mock.calls[0]![1] as { bundleJson: string; filename: string; filepath?: string; sample: Buffer; signal?: AbortSignal };
    expect(m.matchMock.mock.calls[0]![0]).toBe(reservation);
    const expectedBundle = buildYaraBundleJson({
      ruleSetId: SET, version: 4, autoQuarantine: false,
      rules: [
        { id: RULE, name: 'evil_mark', severity: 'critical', source: ruleCols.ruleSource },
        { id: '44444444-4444-4444-8444-444444444444', name: 'other', severity: 'low', source: 'rule other { condition: false }' },
      ],
    });
    expect(input.bundleJson).toBe(expectedBundle);
    expect(input.filename).toBe('invoice.pdf');
    expect(input.filepath).toBe('C:\\Users\\Public\\invoice.pdf');
    expect(input.sample.equals(SAMPLE)).toBe(true);
    expect(input.signal).toBeInstanceOf(AbortSignal);

    const { data } = await res.json();
    expect(data).toEqual({
      sha256: createHash('sha256').update(SAMPLE).digest('hex'),
      size: SAMPLE.length,
      filename: 'invoice.pdf',
      filepath: 'C:\\Users\\Public\\invoice.pdf',
      durationMs: 42,
      testedVersion: 4,
      publishedVersion: 3,
      testedDigest: createHash('sha256').update(expectedBundle, 'utf8').digest('hex'),
      matches: [{ ruleId: RULE, ruleName: 'evil_mark', severity: 'critical', tags: ['ioc'], matchedStrings: [{ id: '$a', offset: 3, data: 'EVILMARK' }] }],
    });
  });

  it('a never-published set is tested at version 1 (DecodeBundle rejects 0); filepath defaults to the filename', async () => {
    mockPhase1([{ ...setRow, currentVersion: 0, publishedVersion: 0, ...ruleCols }]);
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(200);
    const input = m.matchMock.mock.calls[0]![1] as { bundleJson: string; filepath?: string };
    expect(JSON.parse(input.bundleJson).version).toBe(1);
    expect(input.filepath).toBeUndefined();
    const { data } = await res.json();
    expect(data).toMatchObject({ testedVersion: 1, publishedVersion: 0, filepath: 'sample.bin' });
  });

  it('an org user may test the built-in set', async () => {
    mockPhase1([{ ...setRow, setId: YARA_BUILTIN_RULE_SET_ID, setOrgId: null, isBuiltin: true, ...ruleCols }]);
    const res = await post(app(), SAMPLE, 'filename=x.bin', YARA_BUILTIN_RULE_SET_ID);
    expect(res.status).toBe(200);
  });

  it('redacts matched strings the way agent ingest does', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    m.matchMock.mockResolvedValueOnce({
      ...OK_RESULT,
      matches: [{ ...OK_RESULT.matches[0], matchedStrings: [{ id: '$a', offset: 0, data: 'DB_PASSWORD=SuperSecret123' }] }],
    });
    const res = await post(app(), SAMPLE);
    const { data } = await res.json();
    expect(data.matches[0].matchedStrings[0].data).toBe(redactSecretsDeep('DB_PASSWORD=SuperSecret123'));
    expect(data.matches[0].matchedStrings[0].data).not.toContain('SuperSecret123');
  });

  it('once handed to the runner, the route never releases the slot itself (the runner releases on child exit)', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(200);
    expect(m.matchMock.mock.calls[0]![0]).toBe(reservation);
    expect(reservation.release).not.toHaveBeenCalled();
  });

  it('no audit (and so no filename) on a failed test', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    m.matchMock.mockResolvedValueOnce({ ok: false, unavailable: 'timeout' });
    await post(app(), SAMPLE, 'filename=secret-report.docm');
    expect(m.auditMock).not.toHaveBeenCalled();
  });

  it('422 YARA_TEST_COMPILE_FAILED with the compile errors', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const errors = [{ ruleId: RULE, name: 'evil_mark', code: 'compile', message: 'syntax error', line: 2 }];
    m.matchMock.mockResolvedValueOnce({ ok: false, errors });
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'YARA_TEST_COMPILE_FAILED', errors });
  });

  it('503 YARA_TEST_SANDBOX_UNAVAILABLE with a human message (D2)', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    m.matchMock.mockResolvedValueOnce({ ok: false, sandboxUnavailable: true, detail: 'sandbox unavailable: landlock abi: function not implemented' });
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe('YARA_TEST_SANDBOX_UNAVAILABLE');
    expect(json.error).toMatch(/^File tests are not available on this server/);
    expect(JSON.stringify(json)).not.toContain('landlock abi'); // the failed step goes to the log, not the client
  });

  it.each(['timeout', 'ENOENT', 'exit_2: YARA engine failure', 'aborted', 'bad_output: x'])(
    '503 YARA_TEST_UNAVAILABLE when the runner reports %s',
    async (reason) => {
      mockPhase1([{ ...setRow, ...ruleCols }]);
      m.matchMock.mockResolvedValueOnce({ ok: false, unavailable: reason });
      const res = await post(app(), SAMPLE);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('YARA_TEST_UNAVAILABLE');
    },
  );

  it('a runner that throws is a 503, not an unhandled rejection', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    m.matchMock.mockRejectedValueOnce(new Error('boom'));
    const res = await post(app(), SAMPLE);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('YARA_TEST_UNAVAILABLE');
    expect(reservation.release).toHaveBeenCalledTimes(1); // never leak the slot
  });

  it('audits ids, sizes and counts only — never the filename, bytes or matched strings', async () => {
    mockPhase1([{ ...setRow, ...ruleCols }]);
    const res = await post(app(), SAMPLE, 'filename=secret-report.docm&filepath=C%3A%5Csecret');
    expect(res.status).toBe(200);
    expect(m.auditMock).toHaveBeenCalledTimes(1);
    const event = m.auditMock.mock.calls[0]![1];
    expect(event).toMatchObject({ action: 'security.yara_rule_set.test', resourceType: 'yara_rule_set', resourceId: SET });
    expect(event.details).toEqual({
      ruleSetId: SET,
      sampleSha256: createHash('sha256').update(SAMPLE).digest('hex'),
      size: SAMPLE.length,
      matchCount: 1,
      testedVersion: 4,
    });
    const serialized = JSON.stringify(event);
    for (const needle of ['secret-report', 'secret', 'EVILMARK', 'xx ']) expect(serialized).not.toContain(needle);
  });
});
