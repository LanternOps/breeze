import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ending a Quick Support session waits on the agent relay twice. The tool's
 * `end` action therefore manages its own DB context: its reads run in a short
 * caller-scoped context and the teardown runs with none held.
 */

const { state, endSupportSession } = vi.hoisted(() => ({
  state: { depth: 0, opened: 0, selectDepths: [] as number[], rows: [] as unknown[][] },
  endSupportSession: vi.fn(),
}));

vi.mock('../db', () => {
  const select = vi.fn(() => {
    state.selectDepths.push(state.depth);
    const rows = state.rows.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy']) builder[m] = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(rows));
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return builder;
  });
  return {
    db: { select },
    hasDbAccessContext: () => state.depth > 0,
    withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => {
      if (state.depth > 0) return fn();
      state.depth += 1;
      state.opened += 1;
      try { return await fn(); } finally { state.depth -= 1; }
    },
  };
});

vi.mock('../middleware/auth', () => ({ dbAccessContextFromAuth: () => ({ scope: 'partner' }) }));
vi.mock('./quickSupportEnd', () => ({ endSupportSession }));
vi.mock('./aiToolMfaGate', () => ({ mfaGatedToolError: () => null }));
vi.mock('./aiToolsSecurityPolicyShared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolsSecurityPolicyShared')>()),
  auditToolWrite: vi.fn(),
}));

import type { AiTool } from './aiTools';
import { registerSupportSessionTools } from './aiToolsSupportSessions';

const AUTH = {
  scope: 'partner',
  partnerId: 'partner-1',
  user: { id: 'user-1', email: 't@example.com' },
} as never;

function tool(): AiTool {
  const map = new Map<string, AiTool>();
  registerSupportSessionTools(map);
  return map.get('manage_support_sessions')!;
}

describe('manage_support_sessions end', () => {
  beforeEach(() => {
    state.depth = 0;
    state.opened = 0;
    state.selectDepths.length = 0;
    state.rows.length = 0;
    endSupportSession.mockReset();
  });

  it('opts only the end action out of the dispatcher transaction', () => {
    expect(tool().selfManagedDbContext).toEqual(['end']);
  });

  it('reads the session in a short context and ends it with no context held', async () => {
    state.rows.push([{ session: { id: 'sess-1', orgId: 'qs-org', status: 'ready', deviceId: 'dev-1' } }]);
    let depthAtEnd = -1;
    endSupportSession.mockImplementation(async () => {
      depthAtEnd = state.depth;
      return { ended: true, disconnect: 'closed', commandDelivered: true };
    });

    const out = JSON.parse(await tool().handler({ action: 'end', sessionId: 'sess-1' }, AUTH) as string);

    expect(out.ended).toBe(true);
    expect(state.selectDepths).toEqual([1]);
    expect(depthAtEnd).toBe(0);
    expect(state.opened).toBe(1);
  });
});
