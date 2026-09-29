import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ access: vi.fn(), view: vi.fn() }));
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
vi.mock('./aiTools', () => ({ verifyDeviceAccess: m.access }));
vi.mock('./timeSync/view', () => ({ getDeviceTimeStatusView: m.view }));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
it('authorizes first and returns precisely the shared view', async () => {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  const tool = tools.get('get_device_time_status')!;
  expect(tool).toMatchObject({
    tier: 1,
    domain: 'devices',
    deviceArgs: ['deviceId'],
  });
  m.access.mockResolvedValue({ error: 'Device not found or access denied' });
  expect(
    JSON.parse(await tool.handler({ deviceId: 'id' }, {} as any)),
  ).toHaveProperty('error');
  expect(m.view).not.toHaveBeenCalled();
  m.access.mockResolvedValue({ device: { id: 'id' } });
  const view = { deviceId: 'id', state: 'not_reported', enforcement: null };
  m.view.mockResolvedValue(view);
  expect(JSON.parse(await tool.handler({ deviceId: 'id' }, {} as any))).toEqual(
    view,
  );
  expect(m.view).toHaveBeenCalledWith('id');
  m.view.mockRejectedValue(new Error('database'));
  await expect(tool.handler({ deviceId: 'id' }, {} as any)).rejects.toThrow(
    'database',
  );
});
