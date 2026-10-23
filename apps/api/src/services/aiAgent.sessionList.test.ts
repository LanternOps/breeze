import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9427 W1 T5 — the conversation list and search return only CHAT sessions
 * (`general`, `topology`) and carry the org/type/device a client needs to
 * open one elsewhere. Drizzle predicate builders are captured (as in
 * aiAgent.authz.test.ts) so the WHERE and the projection are asserted, not
 * just the mapped rows. The real-Postgres/RLS proof is
 * __tests__/integration/aiSessionList.integration.test.ts.
 */

type Cond = { op: string; col?: unknown; val?: unknown; conds?: Cond[] };

const calls = vi.hoisted(() => ({
  selects: [] as Array<{ projection: Record<string, unknown>; where: Cond | undefined }>,
  results: [] as unknown[][],
}));

function chain(projection: Record<string, unknown>) {
  const entry = { projection, where: undefined as Cond | undefined };
  calls.selects.push(entry);
  const result = calls.results.shift() ?? [];
  const self: any = {
    from: () => self,
    innerJoin: () => self,
    where: (w: Cond) => { entry.where = w; return self; },
    orderBy: () => self,
    limit: () => self,
    offset: () => self,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return self;
}

vi.mock('./topology/aiSessionAccess', () => ({ topologySessionAccessCondition: vi.fn(async () => undefined) }));
vi.mock('../db', () => ({
  db: { select: (projection: Record<string, unknown>) => chain(projection) },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'aiSessions.id',
    orgId: 'aiSessions.orgId',
    userId: 'aiSessions.userId',
    type: 'aiSessions.type',
    deviceId: 'aiSessions.deviceId',
    title: 'aiSessions.title',
    status: 'aiSessions.status',
    model: 'aiSessions.model',
    turnCount: 'aiSessions.turnCount',
    totalCostCents: 'aiSessions.totalCostCents',
    lastActivityAt: 'aiSessions.lastActivityAt',
    createdAt: 'aiSessions.createdAt',
  },
  aiMessages: { sessionId: 'aiMessages.sessionId', content: 'aiMessages.content', role: 'aiMessages.role', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: {},
  approvalRequests: {},
  delegantM365Connections: {},
  devices: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: Object.assign((..._a: unknown[]) => ({ op: 'sql' }), {}),
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn() }));
vi.mock('./aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn(async () => 'partner-1') }));
vi.mock('./aiModels/sessionModel', () => ({ chooseSessionModel: vi.fn() }));

import { CHAT_SESSION_TYPES, listSessions, searchSessions } from './aiAgent';

const auth: any = {
  user: { id: 'user-1' },
  orgId: null,
  orgCondition: (col: unknown) => ({ op: 'orgCondition', col }),
};

function conds(where: Cond | undefined): Cond[] {
  return where?.op === 'and' ? (where.conds ?? []) : where ? [where] : [];
}

const TYPE_FILTER = { op: 'inArray', col: 'aiSessions.type', val: ['general', 'topology'] };

beforeEach(() => {
  calls.selects.length = 0;
  calls.results.length = 0;
});

describe('CHAT_SESSION_TYPES', () => {
  it('is exactly the two chat types', () => {
    expect([...CHAT_SESSION_TYPES]).toEqual(['general', 'topology']);
  });
});

describe('listSessions (#9427)', () => {
  it('filters to chat session types, alongside the owner and org conditions', async () => {
    await listSessions(auth, {});
    const where = conds(calls.selects[0]!.where);
    expect(where).toContainEqual(TYPE_FILTER);
    expect(where).toContainEqual({ op: 'eq', col: 'aiSessions.userId', val: 'user-1' });
    expect(where).toContainEqual({ op: 'orgCondition', col: 'aiSessions.orgId' });
  });

  it('projects orgId, type and deviceId', async () => {
    await listSessions(auth, {});
    expect(calls.selects[0]!.projection).toMatchObject({
      orgId: 'aiSessions.orgId',
      type: 'aiSessions.type',
      deviceId: 'aiSessions.deviceId',
      id: 'aiSessions.id',
      title: 'aiSessions.title',
      status: 'aiSessions.status',
    });
  });
});

describe('searchSessions (#9427)', () => {
  it('filters BOTH sub-queries (title and message content) to chat session types', async () => {
    await searchSessions(auth, 'disk', {});
    expect(calls.selects).toHaveLength(2);
    for (const select of calls.selects) {
      expect(conds(select.where)).toContainEqual(TYPE_FILTER);
      expect(conds(select.where)).toContainEqual({ op: 'eq', col: 'aiSessions.userId', val: 'user-1' });
    }
  });

  it('returns status, type, orgId and deviceId for title and content matches', async () => {
    const createdAt = new Date('2026-10-22T00:00:00Z');
    calls.results.push(
      [{ id: 's1', title: 'disk full', createdAt, status: 'active', type: 'general', orgId: 'org-a', deviceId: null }],
      [{ sessionId: 's2', content: 'the disk is at 99%', sessionTitle: 'Server', sessionCreatedAt: createdAt, status: 'closed', type: 'topology', orgId: 'org-b', deviceId: 'dev-1' }],
    );
    const results = await searchSessions(auth, 'disk', {});
    expect(results).toEqual([
      { id: 's1', title: 'disk full', matchedContent: 'disk full', createdAt, status: 'active', type: 'general', orgId: 'org-a', deviceId: null },
      expect.objectContaining({ id: 's2', title: 'Server', createdAt, status: 'closed', type: 'topology', orgId: 'org-b', deviceId: 'dev-1' }),
    ]);
    expect(calls.selects[0]!.projection).toMatchObject({ status: 'aiSessions.status', type: 'aiSessions.type', orgId: 'aiSessions.orgId', deviceId: 'aiSessions.deviceId' });
    expect(calls.selects[1]!.projection).toMatchObject({ status: 'aiSessions.status', type: 'aiSessions.type', orgId: 'aiSessions.orgId', deviceId: 'aiSessions.deviceId' });
  });
});
