import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review R1 (#6671 shape): a topology tool call must resolve its AI
 * preconditions (flags + provider/org readiness, partner-axis reads) BEFORE
 * the tool's own DB context opens, and carry them in — never reach for a
 * second pooled connection from inside the held tool transaction.
 */
const trace = vi.hoisted(() => ({ events: [] as string[], held: 0 }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => {
    trace.events.push('toolContext:open');
    trace.held += 1;
    try { return await fn(); } finally { trace.held -= 1; trace.events.push('toolContext:close'); }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));
vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));
vi.mock('./aiToolOutput', () => ({ compactToolResultForChat: vi.fn((_t: string, raw: string) => raw), setToolPaginationHintResolver: vi.fn() }));
vi.mock('./aiToolsM365', () => ({
  m365LookupUserHandler: vi.fn(), m365RecentSigninsHandler: vi.fn(), m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(), m365ResetPasswordHandler: vi.fn(), registerM365Tools: vi.fn(),
}));
const carried = vi.hoisted(() => ({ current: null as null | { orgId: string } }));
vi.mock('./topology/aiToolGate', async (original) => ({
  ...await original<object>(),
  loadTopologyAiPreconditions: vi.fn(async (orgId: string) => {
    trace.events.push(`preconditions:resolve(held=${trace.held})`);
    return { orgId, flags: {}, readiness: { provider: true, orgPolicy: true } };
  }),
  withTopologyAiPreconditions: vi.fn(async (pre: { orgId: string }, fn: () => Promise<unknown>) => {
    carried.current = pre;
    try { return await fn(); } finally { carried.current = null; }
  }),
}));
const mockExecuteTool = vi.hoisted(() => vi.fn());
vi.mock('./aiTools', async (original) => ({
  ...await original<Record<string, unknown>>(),
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

import { __test__ } from './aiAgentSdkTools';

const auth = { scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'], partnerId: 'partner-1', user: { id: 'user-1' } } as never;
const session = { orgId: 'org-1', breezeSessionId: 'session-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  trace.events.length = 0;
  trace.held = 0;
  mockExecuteTool.mockImplementation(async () => {
    trace.events.push(`execute(carried=${carried.current?.orgId ?? 'none'},held=${trace.held})`);
    return JSON.stringify({ ok: true });
  });
});

describe('topology tool calls carry pre-resolved AI preconditions (review R1)', () => {
  it.each(['get_topology', 'diagnose_connectivity'])('%s resolves preconditions for the SESSION org before the tool context opens', async (tool) => {
    await __test__.makeToolHandler(tool, () => auth, () => session)({ site_id: 'site-1' });
    expect(trace.events).toEqual([
      'preconditions:resolve(held=0)',
      'toolContext:open',
      'execute(carried=org-1,held=1)',
      'toolContext:close',
    ]);
  });

  it('leaves every other tool untouched (no extra reads)', async () => {
    await __test__.makeToolHandler('list_scripts', () => auth, () => session)({});
    expect(trace.events).toEqual(['toolContext:open', 'execute(carried=none,held=1)', 'toolContext:close']);
  });
});
