import { describe, it, expect, vi, beforeEach } from 'vitest';

const device: Record<string, unknown> = {
  id: 'dev-1', orgId: 'org-1', osType: 'windows', status: 'online', agentId: 'agent-1',
  hostname: 'WIN-A', siteId: null, customFields: {},
};
const mockDispatch = vi.fn();
// Select 0 = the device lookup; every later select = the command poll.
const commandRows: Array<Record<string, unknown>> = [];
let selectCalls = 0;

vi.mock('../../db', () => ({
  db: {
    select: () => {
      const call = selectCalls++;
      return {
        from: () => ({ where: () => ({ limit: async () => (call === 0 ? [device] : commandRows) }) }),
      };
    },
  },
}));
vi.mock('../scriptDispatch', () => ({ dispatchScriptToDevice: (...a: unknown[]) => mockDispatch(...a) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { ensureRestoreCheckpoint, RESTORE_CHECKPOINT_SCRIPT, RESTORE_CHECKPOINT_CLASSES } from './restoreCheckpoint';

beforeEach(() => {
  mockDispatch.mockReset();
  commandRows.length = 0;
  selectCalls = 0;
  device.osType = 'windows';
});

describe('ensureRestoreCheckpoint', () => {
  it('names exactly the classes a restore point can undo', () => {
    expect([...RESTORE_CHECKPOINT_CLASSES].sort()).toEqual(['files_system', 'registry', 'services']);
  });

  it('refuses on a non-Windows device without dispatching anything', async () => {
    device.osType = 'linux';
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'unsupported_platform' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('dispatches the FIXED system script, never caller-supplied content', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ status: 'completed', result: { exitCode: 0, stdout: 'BREEZE_CHECKPOINT_OK seq=42' } });
    const res = await ensureRestoreCheckpoint('dev-1');
    const arg = mockDispatch.mock.calls[0]![0] as {
      source: { kind: string; content: string; language: string };
      runAs: string;
      offlinePolicy: { kind: string };
    };
    expect(arg.source.kind).toBe('raw');
    expect(arg.source.content).toBe(RESTORE_CHECKPOINT_SCRIPT);
    expect(arg.source.language).toBe('powershell');
    expect(arg.runAs).toBe('system');
    expect(arg.offlinePolicy).toEqual({ kind: 'reject' });
    expect(res).toEqual({ ok: true, checkpointRef: '42' });
  });

  it('the fixed script fails loudly instead of silently skipping', () => {
    expect(RESTORE_CHECKPOINT_SCRIPT).toContain('$ErrorActionPreference = "Stop"');
    expect(RESTORE_CHECKPOINT_SCRIPT).toContain('Checkpoint-Computer');
    expect(RESTORE_CHECKPOINT_SCRIPT).toContain('no restore point was created');
  });

  it('bypasses the maintenance window — the checkpoint protects a run the lane already admitted', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ status: 'completed', result: { exitCode: 0, stdout: 'BREEZE_CHECKPOINT_OK seq=1' } });
    await ensureRestoreCheckpoint('dev-1');
    expect((mockDispatch.mock.calls[0]![0] as { bypassMaintenanceWindow: boolean }).bypassMaintenanceWindow).toBe(true);
  });

  it('fails closed when dispatch is refused', async () => {
    mockDispatch.mockResolvedValue({ ok: false, code: 'device_offline', error: 'offline' });
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'device_unavailable' });
    mockDispatch.mockResolvedValue({ ok: false, code: 'insert_failed', error: 'x' });
    selectCalls = 0;
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'dispatch_failed' });
  });

  it('fails closed on a non-zero exit code', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ status: 'completed', result: { exitCode: 1, stdout: '', stderr: 'SR disabled' } });
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'checkpoint_failed' });
  });

  it('fails closed on exit 0 without the success marker', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ status: 'completed', result: { exitCode: 0, stdout: 'WARNING: throttled' } });
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'checkpoint_failed' });
  });

  it('fails closed when the command terminalises without an exit code (server-side timeout)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ status: 'timeout', result: null });
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'checkpoint_failed' });
  });

  it('fails closed when the command never reports', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ status: 'pending', result: null });
    await expect(ensureRestoreCheckpoint('dev-1', { timeoutMs: 30, pollMs: 10 })).resolves.toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('fails closed (dispatch_failed) when the dispatch throws', async () => {
    mockDispatch.mockRejectedValue(new Error('boom'));
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'dispatch_failed' });
  });
});
