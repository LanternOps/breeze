import { describe, expect, it, vi } from 'vitest';

// §13 row 9. filesystem_analysis is dispatched with preferHeartbeat: false, so
// its result normally arrives over the WebSocket — and the WS leg dispatches
// ONLY this registry. Without an entry here the scan completes, the agent's
// payload is discarded, and the Disk Cleanup tab stays empty with no error.

vi.mock('../routes/agents/helpers', () => ({
  handleFilesystemAnalysisCommandResult: vi.fn(async () => {}),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ orgId: 'org-123' }]) })),
      })),
    })),
  },
}));

import { commandResultHandlers } from './commandResultHandlers';
import { handleFilesystemAnalysisCommandResult } from '../routes/agents/helpers';

describe('filesystem_analysis result handler registration', () => {
  it('is registered, so the WebSocket leg persists the snapshot', () => {
    expect(commandResultHandlers['filesystem_analysis']).toBeTypeOf('function');
  });

  it('forwards the command and the device org to the existing handler', async () => {
    const command = {
      id: 'cmd-1',
      deviceId: 'dev-1',
      type: 'filesystem_analysis',
      payload: { path: '/', trigger: 'on_demand', scanMode: 'baseline' },
    } as never;
    const result = { status: 'completed', stdout: '{"path":"/"}' } as never;

    await commandResultHandlers['filesystem_analysis']!({
      agentId: 'agent-1',
      command,
      commandId: 'cmd-1',
      result,
      resolvedDeviceId: 'dev-1',
      stdout: '{"path":"/"}',
    });

    expect(handleFilesystemAnalysisCommandResult).toHaveBeenCalledWith(command, result, 'org-123');
  });
});
