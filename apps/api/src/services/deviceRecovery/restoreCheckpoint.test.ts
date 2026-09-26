import { describe, it, expect, vi, beforeEach } from 'vitest';

const device: Record<string, unknown> = {
  id: 'dev-1', orgId: 'org-1', osType: 'windows', status: 'online', agentId: 'agent-1',
  hostname: 'WIN-A', siteId: null, customFields: {},
};
const mockDispatch = vi.fn();
// Select 0 = the device lookup; every later select = the command poll.
const commandRows: Array<Record<string, unknown>> = [];
let selectCalls = 0;

// `open`: system contexts not yet committed. `pollOpen`: what each command
// poll observed (#7103 — must be a fresh context, not the creating one).
const txState = { open: 0, pollOpen: [] as number[], creatingTxId: 0, txSeq: 0, currentTx: 0 };

vi.mock('../../db', () => ({
  runOutsideDbContext: async (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => {
    const saved = txState.currentTx;
    txState.open += 1;
    txState.currentTx = ++txState.txSeq;
    try {
      return await fn();
    } finally {
      txState.open -= 1;
      txState.currentTx = saved;
    }
  },
  db: {
    select: () => {
      const call = selectCalls++;
      if (call > 0) txState.pollOpen.push(txState.currentTx);
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
  txState.open = 0;
  txState.pollOpen = [];
  txState.txSeq = 0;
  txState.currentTx = 0;
  txState.creatingTxId = 0;
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

  // #7103 — the lane checkpoint ran dispatch AND its 180 s poll inside one
  // system transaction. The command was sent before its rows committed, and
  // the rows stayed invisible to the agent result path for the whole poll.
  it('sends only after the rows commit, and polls in fresh contexts (#7103)', async () => {
    const events: Array<{ kind: string; open: number }> = [];
    mockDispatch.mockImplementation(async (input: { deferDelivery?: boolean }) => {
      events.push({ kind: 'create', open: txState.open });
      txState.creatingTxId = txState.currentTx;
      const base = { ok: true, commandId: 'cmd-1', executionId: null };
      const deliver = async () => {
        events.push({ kind: 'send', open: txState.open });
        return { ...base, delivered: true, deliveryOutcome: 'sent' };
      };
      return input.deferDelivery
        ? { ...base, delivered: false, deliveryOutcome: 'deferred', deliver }
        : deliver();
    });
    commandRows.push({ status: 'completed', result: { exitCode: 0, stdout: 'BREEZE_CHECKPOINT_OK seq=7' } });

    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: true, checkpointRef: '7' });

    expect(mockDispatch.mock.calls[0]![0]).toMatchObject({ deferDelivery: true });
    expect(events).toEqual([
      { kind: 'create', open: 1 },
      { kind: 'send', open: 0 },
    ]);
    // Every poll runs in a context of its own, never the one that created the rows.
    expect(txState.pollOpen.length).toBeGreaterThan(0);
    for (const tx of txState.pollOpen) {
      expect(tx).not.toBe(0);
      expect(tx).not.toBe(txState.creatingTxId);
    }
  });

  it('a send that throws still polls the committed command (#7103)', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: null,
      delivered: false,
      deliveryOutcome: 'deferred',
      deliver: async () => { throw new Error('socket exploded'); },
    });
    commandRows.push({ status: 'completed', result: { exitCode: 0, stdout: 'BREEZE_CHECKPOINT_OK seq=9' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: true, checkpointRef: '9' });
    error.mockRestore();
  });
});
