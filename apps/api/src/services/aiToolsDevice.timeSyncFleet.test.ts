import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(),
  getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(),
  resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: vi.fn() }));
vi.mock('./timeSync/fleet', async (original) => ({
  ...(await original<typeof import('./timeSync/fleet')>()),
  listFleetTimeStatus: m.list,
}));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
it('uses the shared bounded query and the exact caller authorization', async () => {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  const tool = tools.get('list_time_sync_issues')!;
  const auth = { scope: 'organization' } as AuthContext;
  const value = { data: [], total: 0, page: 1, limit: 50, domains: [] };
  m.list.mockResolvedValue(value);
  expect(
    JSON.parse(
      await tool.handler(
        { finding: 'sync_stale', role: 'member', domain: 'example.com' },
        auth,
      ),
    ),
  ).toEqual(value);
  expect(m.list).toHaveBeenCalledWith(
    {
      finding: 'sync_stale',
      role: 'member',
      domain: 'example.com',
      page: 1,
      limit: 50,
    },
    auth,
  );
  m.list.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(tool.handler({}, auth)).rejects.toThrow('database unavailable');
});
