import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queue: vi.fn(async () => ({ command: { id: 'cmd-1' } }) as { command?: { id: string }; error?: string }),
  exec: vi.fn(),
  cleanup: vi.fn(async () => ({ ok: true, commandId: 'cmd-9', cleanupRunId: 'run-9', deadlineAt: '' }) as Record<string, unknown>),
}));
vi.mock('../commandQueue', () => ({
  CommandTypes: { RESTART_SERVICE: 'restart_service', KILL_PROCESS: 'kill_process', LIST_PROCESSES: 'list_processes' },
  queueCommandForExecutionWithSystemPrecheck: h.queue,
  executeCommandWithSystemPrecheck: h.exec,
}));
vi.mock('../systemCleanup', () => ({ startSystemCleanupRun: h.cleanup }));

import { clampBuiltinRisk, dispatchBuiltinAction } from './builtinActions';
import { cleanupActionsForOs } from '../aiAgents/researchSubmission';

const device = { id: 'd-1', orgId: 'org-1', osType: 'windows', agentVersion: '1.0.0', status: 'online' };
const opts = { userId: 'u-1', expectedOrgId: 'org-1' };
const run = (action: string, parameters: unknown, dev = device) =>
  dispatchBuiltinAction({ action: action as never, parameters, device: dev, userId: 'u-1' });

describe('built-in action dispatch', () => {
  beforeEach(() => { h.queue.mockClear(); h.exec.mockReset(); h.cleanup.mockClear(); });

  it('reboot and restart_service queue one command with typed params, pinned to the org', async () => {
    await expect(run('reboot', {})).resolves.toEqual({ ok: true, commandId: 'cmd-1', cleanupRunId: null });
    expect(h.queue).toHaveBeenLastCalledWith('d-1', 'reboot', {}, opts);
    await run('restart_service', { serviceName: 'Spooler' });
    expect(h.queue).toHaveBeenLastCalledWith('d-1', 'restart_service', { name: 'Spooler' }, opts);
  });

  it('a queue refusal is a 503 with no command id', async () => {
    h.queue.mockResolvedValueOnce({ error: 'Device is offline' });
    await expect(run('reboot', {})).resolves.toEqual({ ok: false, status: 503, error: 'Device is offline' });
  });

  it('refuses params that no longer parse (an edited row cannot smuggle a payload)', async () => {
    await expect(run('restart_service', { serviceName: '' })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(run('reboot', { force: true })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('kill_process kills only a single exact-name match', async () => {
    h.exec.mockResolvedValueOnce({ status: 'completed', stdout: JSON.stringify({ processes: [{ pid: 42, name: 'SPOOLSV.EXE' }, { pid: 7, name: 'spoolsv-helper.exe' }] }) });
    await expect(run('kill_process', { processName: 'spoolsv.exe' })).resolves.toMatchObject({ ok: true, commandId: 'cmd-1' });
    expect(h.exec).toHaveBeenCalledWith('d-1', 'list_processes', expect.any(Object), expect.objectContaining({ expectedOrgId: 'org-1', userId: 'u-1' }));
    expect(h.queue).toHaveBeenLastCalledWith('d-1', 'kill_process', { pid: 42, force: false }, opts);
  });

  it.each([
    [[], 'process_not_running'],
    [[{ pid: 1, name: 'chrome.exe' }, { pid: 2, name: 'chrome.exe' }], 'process_ambiguous'],
  ])('kill_process with matches %o → 409 %s', async (processes, error) => {
    h.exec.mockResolvedValueOnce({ status: 'completed', stdout: JSON.stringify({ processes }) });
    await expect(run('kill_process', { processName: 'chrome.exe' })).resolves.toEqual({ ok: false, status: 409, error });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('kill_process: an unreadable or failed process list is a 503, never a kill', async () => {
    h.exec.mockResolvedValueOnce({ status: 'failed', stdout: '' });
    await expect(run('kill_process', { processName: 'x.exe' })).resolves.toMatchObject({ ok: false, status: 503 });
    h.exec.mockResolvedValueOnce({ status: 'completed', stdout: 'not json' });
    await expect(run('kill_process', { processName: 'x.exe' })).resolves.toMatchObject({ ok: false, status: 503 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('disk_cleanup starts an OS-native run with OS-allowed ids only (against the device OS now)', async () => {
    await expect(run('disk_cleanup', { actionIds: ['mac_brew_cleanup'] })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(h.cleanup).not.toHaveBeenCalled();
    const winId = [...cleanupActionsForOs('windows')][0]!;
    await expect(run('disk_cleanup', { actionIds: [winId] })).resolves.toEqual({ ok: true, commandId: 'cmd-9', cleanupRunId: 'run-9' });
    expect(h.cleanup).toHaveBeenCalledWith({ device, requestedBy: 'u-1', actionIds: [winId] });
    // The device was re-imaged to Linux since the suggestion was written: a windows id is now refused.
    h.cleanup.mockClear();
    await expect(run('disk_cleanup', { actionIds: [winId] }, { ...device, osType: 'linux' })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it('passes a cleanup refusal through with its status (403 remote-access policy)', async () => {
    const winId = [...cleanupActionsForOs('windows')][0]!;
    h.cleanup.mockResolvedValueOnce({ ok: false, status: 403, error: 'remote tools disabled' });
    await expect(run('disk_cleanup', { actionIds: [winId] })).resolves.toEqual({ ok: false, status: 403, error: 'remote tools disabled' });
  });

  it('risk floors: reboot is always high; the model may raise, never lower', () => {
    expect(clampBuiltinRisk('reboot', 'low')).toBe('high');
    expect(clampBuiltinRisk('restart_service', 'low')).toBe('medium');
    expect(clampBuiltinRisk('restart_service', 'critical')).toBe('critical');
    expect(clampBuiltinRisk('disk_cleanup', 'low')).toBe('low');
  });
});
