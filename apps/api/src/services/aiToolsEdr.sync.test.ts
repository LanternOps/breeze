import { beforeEach, describe, expect, it, vi } from 'vitest';

// sync_edr_data (#8167 W03 PR-B): Tier-2 "sync now" — the same gate as
// POST /edr/connections/:id/sync, enqueue outside any DB context.
const h = vi.hoisted(() => ({
  depth: 0,
  enqueueDepths: [] as number[],
  enqueue: vi.fn(async (..._a: unknown[]) => 'job-1'),
  rows: [] as Array<Record<string, unknown>>,
  selectCalls: 0,
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) chain[k] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(h.rows).then(res);
  return {
    db: { select: vi.fn(() => { h.selectCalls += 1; return chain; }), selectDistinct: vi.fn(() => { h.selectCalls += 1; return chain; }) },
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => {
      const saved = h.depth; h.depth = 0;
      try { return await fn(); } finally { h.depth = saved; }
    }),
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    hasDbAccessContext: vi.fn(() => false),
  };
});
vi.mock('../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth')>('../middleware/auth');
  return {
    ...actual,
    withAuthDbAccessContext: vi.fn(async (_a: unknown, fn: () => Promise<unknown>) => {
      h.depth += 1;
      try { return await fn(); } finally { h.depth -= 1; }
    }),
  };
});
vi.mock('../jobs/edrProviderSync', () => ({
  enqueueEdrSync: (...a: unknown[]) => { h.enqueueDepths.push(h.depth); return h.enqueue(...a); },
}));
vi.mock('./edrProviders/actions', () => ({ dispatchEdrAction: vi.fn() }));

import { aiTools, type AiTool } from './aiTools';
import { registerEdrTools } from './aiToolsEdr';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { checkGuardrails, TOOL_PERMISSIONS } from './aiGuardrails';
import { TOOL_RATE_LIMITS } from './aiToolRateLimits';
import type { AuthContext } from '../middleware/auth';

const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000o1'.replace('o', 'a');

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerEdrTools(reg);
  return reg.get('sync_edr_data')!.handler;
}
function auth(over: Record<string, unknown> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: { mfa: true } as any, partnerId: 'p1', orgId: null, scope: 'partner', partnerOrgAccess: 'all',
    accessibleOrgIds: null, orgCondition: () => undefined, canAccessOrg: () => true,
    principal: { kind: 'user_session' },
    ...over,
  } as unknown as AuthContext;
}
const run = (input: Record<string, unknown>, a = auth()) => handler()(input, a).then((s) => JSON.parse(s as string));

beforeEach(() => {
  vi.clearAllMocks();
  h.depth = 0; h.enqueueDepths = []; h.selectCalls = 0;
  h.rows = [{ id: C1, provider: 'bitdefender', isActive: true }];
  h.enqueue.mockResolvedValue('job-1');
});

describe('sync_edr_data — registration (every registry)', () => {
  it('is registered at base tier 2 with organizations.write (route parity with POST /edr/connections/:id/sync)', () => {
    const tool = aiTools.get('sync_edr_data')!;
    expect(tool).toBeDefined();
    expect(tool.tier).toBe(2);
    expect(TOOL_TIERS['sync_edr_data' as keyof typeof TOOL_TIERS]).toBe(2);
    expect(TOOL_PERMISSIONS.sync_edr_data).toEqual({ resource: 'organizations', action: 'write' });
    expect(TOOL_RATE_LIMITS.sync_edr_data).toEqual({ limit: 3, windowSeconds: 600 });
    expect(checkGuardrails('sync_edr_data', {})).toMatchObject({ tier: 2 });
    expect(tool.definition.description?.length ?? 0).toBeLessThanOrEqual(300);
  });

  it('schema: optional uuid connectionId / orgId only', () => {
    const s = toolInputSchemas.sync_edr_data!;
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ connectionId: C1 }).success).toBe(true);
    expect(s.safeParse({ orgId: ORG }).success).toBe(true);
    expect(s.safeParse({ connectionId: 'nope' }).success).toBe(false);
    expect(s.safeParse({ orgId: 'nope' }).success).toBe(false);
  });
});

describe('sync_edr_data — gates', () => {
  it('an organization-scope caller is refused (no read, no enqueue)', async () => {
    const out = await run({}, auth({ scope: 'organization', orgId: ORG, partnerId: null, partnerOrgAccess: null }));
    expect(out.error).toBeDefined();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.selectCalls).toBe(0);
  });

  it('a selected-org partner user is refused (partner-wide effect)', async () => {
    const out = await run({}, auth({ partnerOrgAccess: 'selected' }));
    expect(out.error).toBeDefined();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('an orgId the caller cannot access is refused', async () => {
    const out = await run({ orgId: ORG }, auth({ canAccessOrg: () => false }));
    expect(out.error).toBeDefined();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('sync_edr_data — enqueue', () => {
  it('queues both streams per connection OUTSIDE any DB context', async () => {
    const out = await run({ connectionId: C1 });
    expect(h.enqueue.mock.calls).toEqual([[C1, 'inventory'], [C1, 'detections']]);
    expect(h.enqueueDepths).toEqual([0, 0]);
    expect(out).toMatchObject({ queued: [{ connectionId: C1, provider: 'bitdefender' }] });
  });

  it('an unknown connection id -> error, nothing queued', async () => {
    h.rows = [];
    const out = await run({ connectionId: C2 });
    expect(out.error).toBeDefined();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('inactive connections are skipped with a reason; active ones still queue', async () => {
    h.rows = [{ id: C1, provider: 'bitdefender', isActive: true }, { id: C2, provider: 'bitdefender', isActive: false }];
    const out = await run({});
    expect(h.enqueue.mock.calls.map((c) => c[0])).toEqual([C1, C1]);
    expect(out.skipped).toEqual([{ connectionId: C2, reason: expect.stringMatching(/disabled/i) }]);
  });

  it('an enqueue failure is reported, not thrown', async () => {
    h.enqueue.mockRejectedValue(new Error('redis down'));
    const out = await run({ connectionId: C1 });
    expect(out.error).toBeDefined();
  });
});
