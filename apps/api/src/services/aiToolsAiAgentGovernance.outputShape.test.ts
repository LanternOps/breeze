// A-W05 Task 5a: list_ai_agents offset-mode envelope (paged inside the
// `listAgents` service per Q11, not sliced in the tool handler).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));

const agentServiceMock = vi.hoisted(() => ({ listAgents: vi.fn() }));
vi.mock('./aiAgents/agentService', () => agentServiceMock);

import { aiTools } from './aiToolNames';
import './aiTools';

const AGENT_ROW = {
  id: 'id', name: 'medium', kind: 'short', enabled: 'bool', orgId: 'id', partnerId: 'id', createdAt: 'ts',
} as const;
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  user: { id: 'u1' },
}) as never;

describe('list_ai_agents output shape (A-W05)', () => {
  const tool = aiTools.get('list_ai_agents')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted, carries the envelope and pages via the service', async () => {
    agentServiceMock.listAgents.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => fixtureRow(i, AGENT_ROW)),
    );
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['agents', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(25);
    expect(out.offset).toBe(0);
    // Q11: `listAgents` receives limit/offset — pagination happens in the
    // service, not by fetching everything and slicing in the handler.
    expect(agentServiceMock.listAgents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 26, offset: 0 }),
    );
    expectDefaultPageFits('list_ai_agents', raw);
  });

  it('refuses a garbage cursor rather than silently resetting to page 1', async () => {
    agentServiceMock.listAgents.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => fixtureRow(i, AGENT_ROW)),
    );
    // `includeDisabled` is an opt-in projection flag (Q2), exempt from the
    // fingerprint by design, so cross-filter mismatch isn't reachable with
    // this tool's only other parameter — exercise the malformed-cursor path
    // (CURSOR_INVALID) instead of CURSOR_MISMATCH.
    const out = JSON.parse(await tool.handler({ cursor: 'not-a-real-cursor' }, auth())) as { code?: string };
    expect(out.code).toBe('CURSOR_INVALID');
  });
});
