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
  it('gets the execution ceiling the W04 run budget is capped at', () => {
    // §5.3 / §13 #14: the handler waits `systemCleanupRunBudgetMs(actionIds)`,
    // which is capped at SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS (3 h). The outer
    // tool guard must sit at that ceiling, or it cancels a run the device is
    // still executing. The default 60s would abandon every real run at the
    // first action.
    expect(getToolTimeout('system_cleanup')).toBe(SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS);
    expect(getToolTimeout('system_cleanup')).toBe(3 * 60 * 60 * 1000);
  });

  it('appears in the generated system-prompt tool index under Devices', () => {
    // The plan's static "Files & Disk" prompt line was replaced by the
    // registry-generated index (#6341): a tool with a domain and a searchHint
    // is listed automatically, so this pins that system_cleanup carries both.
    const index = renderToolIndexByDomain(['system_cleanup']);
    expect(index).toContain('- **Devices**: system_cleanup (list/run)');
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

  it('leaves a small result untouched', () => {
    const payload = { cleanupRunId: 'run-1', freedBytes: 0, actions: [{ id: 'a', status: 'failed', outputTail: 'boom' }] };
    const compacted = JSON.parse(compactToolResultForChat('system_cleanup', JSON.stringify(payload)));
    expect(compacted).toEqual(payload);
  });
});
