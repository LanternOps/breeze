import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #11861 at the dispatch chokepoint: `executeTool` is what the MCP server,
 * flows, the durable approval release worker (a STORED call, replayed with
 * `context.actionIntentId`) and every SDK handler call. A call carrying an
 * argument the tool does not define must come back as the clear validation
 * error — a normal `{ error }` tool result — never a throw (a 500 / a failed
 * job with an opaque message), and must never reach the handler.
 */
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  hasDbAccessContext: vi.fn(() => true),
  db: { select: vi.fn() },
}));

import { aiTools, executeTool } from './aiTools';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const auth = {
  user: { id: 'user-1', email: 'u@example.com', name: 'U' },
  token: {} as never,
  partnerId: null,
  orgId: 'org-123',
  scope: 'organization',
  accessibleOrgIds: ['org-123'],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;

let original: AiTool;
const handler = vi.fn(async () => JSON.stringify({ devices: [] }));

beforeEach(() => {
  handler.mockClear();
  original = aiTools.get('query_devices')!;
  aiTools.set('query_devices', { ...original, handler } as AiTool);
});
afterEach(() => {
  aiTools.set('query_devices', original);
});

describe('executeTool refuses unknown arguments with a tool-result error (#11861)', () => {
  it('a live call: query_devices({ filter }) returns the refusal and never runs the handler', async () => {
    const text = await executeTool('query_devices', { filter: 'online' }, auth);
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toMatch(/^Invalid input: unknown argument "filter" \(accepted: status, osType, siteId, search, tags, /);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a stored call replayed by the release worker fails the same way, without throwing', async () => {
    const replay = executeTool('query_devices', { search: 'web', legacyFilter: true }, auth, {
      context: { actionIntentId: '00000000-0000-4000-8000-000000000001' } as never,
    });
    await expect(replay).resolves.toContain('unknown argument \\"legacyFilter\\"');
    expect(handler).not.toHaveBeenCalled();
  });

  it('a call with known arguments still reaches the handler', async () => {
    await executeTool('query_devices', { search: 'web' }, auth);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
