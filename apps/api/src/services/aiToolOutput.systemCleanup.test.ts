import { describe, expect, it } from 'vitest';
import { compactToolResultForChat } from './aiToolOutput';
import { getToolTimeout } from './toolTimeouts';
import { SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS } from './commandTimeouts';
import { renderToolIndexByDomain } from './aiToolIndex';

/**
 * Disk Cleanup v2 W05, spec §9.3 item 6.
 *
 * A `system_cleanup list` catalog carries one row per action with a label, a
 * description, risk flags and sub-actions (the Windows handler allowlist alone
 * is 20 entries), and a `run` result carries a 16 KiB output tail PER ACTION.
 * Unbounded, that is a multi-hundred-kilobyte tool result pasted into the
 * model's context for what is a short answer.
 */
describe('system_cleanup output compaction', () => {
  it('gets a short tool timeout: no action waits longer than the 60 s list cap', () => {
    // W05 review F1: `run` returns immediately and `status` is a read, so the
    // only wait left is `list`'s 60 s cap. The outer guard sits just above it
    // (dispatch + device resolution) — never the 3 h run ceiling, which pinned
    // the SDK's per-tool DB context for the length of a DISM run (#1105).
    expect(getToolTimeout('system_cleanup')).toBe(90_000);
    expect(getToolTimeout('system_cleanup')).toBeLessThan(SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS);
  });

  it('appears in the generated system-prompt tool index under Devices', () => {
    // The plan's static "Files & Disk" prompt line was replaced by the
    // registry-generated index (#6341): a tool with a domain and a searchHint
    // is listed automatically, so this pins that system_cleanup carries both.
    const index = renderToolIndexByDomain(['system_cleanup']);
    expect(index).toContain('- **Devices**: system_cleanup (list/run/status)');
  });

  it('truncates a long action list and says how many it dropped', () => {
    const actions = Array.from({ length: 80 }, (_, i) => ({
      id: `action_${i}`, label: `Action ${i}`, available: true, estimateKnown: false,
    }));
    const compacted = JSON.parse(
      compactToolResultForChat('system_cleanup', JSON.stringify({ catalog: { catalogVersion: 1, actions } })),
    );

    expect(compacted.catalog.actions).toHaveLength(40);
    expect(compacted.catalog.returnedActionCount).toBe(40);
    expect(compacted.catalog.totalActionCount).toBe(80);
    expect(compacted.catalog.truncatedActionCount).toBe(40);
  });

  it('caps each run action’s outputTail instead of pasting 16 KiB per action', () => {
    const compacted = JSON.parse(
      compactToolResultForChat('system_cleanup', JSON.stringify({
        cleanupRunId: 'run-1',
        freedBytes: 1024,
        actions: [{ id: 'win_dism_component_cleanup', status: 'completed', outputTail: 'x'.repeat(20_000) }],
      })),
    );

    expect(compacted.actions[0].outputTail.length).toBeLessThanOrEqual(2_000);
    expect(compacted.actions[0].outputTailTruncated).toBe(true);
    // The numbers the answer is built from are never dropped.
    expect(compacted.freedBytes).toBe(1024);
    expect(compacted.actions[0].status).toBe('completed');
  });

  it('leaves the run handle and the pending-list shapes untouched', () => {
    const handle = {
      status: 'running', cleanupRunId: 'run-1', commandId: 'cmd-1', deviceId: 'dev-1',
      actionIds: ['win_cleanmgr'], deadlineAt: '2026-09-19T10:20:00.000Z',
      note: 'Poll with action "status" and this cleanupRunId.',
    };
    expect(JSON.parse(compactToolResultForChat('system_cleanup', JSON.stringify(handle)))).toEqual(handle);
    const pending = { status: 'pending', commandId: 'cmd-1', note: 'Call list again with this commandId.' };
    expect(JSON.parse(compactToolResultForChat('system_cleanup', JSON.stringify(pending)))).toEqual(pending);
  });

  it('compacts a status result the same way as the old inline run result', () => {
    const compacted = JSON.parse(
      compactToolResultForChat('system_cleanup', JSON.stringify({
        cleanupRunId: 'run-1', status: 'executed', error: null, freedBytes: 4096, deadlineAt: null,
        actions: [{ id: 'win_dism_component_cleanup', status: 'completed', outputTail: 'y'.repeat(5_000) }],
        volumes: [{ mount: 'C:\\', freeBefore: 1, freeAfter: 4097 }],
      })),
    );
    expect(compacted.status).toBe('executed');
    expect(compacted.freedBytes).toBe(4096);
    expect(compacted.actions[0].outputTail.length).toBeLessThanOrEqual(2_000);
    expect(compacted.actions[0].outputTailTruncated).toBe(true);
    expect(compacted.volumes).toHaveLength(1);
  });

  it('leaves a small result untouched', () => {
    const payload = { cleanupRunId: 'run-1', freedBytes: 0, actions: [{ id: 'a', status: 'failed', outputTail: 'boom' }] };
    const compacted = JSON.parse(compactToolResultForChat('system_cleanup', JSON.stringify(payload)));
    expect(compacted).toEqual(payload);
  });
});
