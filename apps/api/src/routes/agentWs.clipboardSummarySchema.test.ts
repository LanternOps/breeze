import { describe, it, expect } from 'vitest';
import { desktopCommandResultSchema } from './agentWs';

// The agent reports a session's clipboard transfer counters as their own
// `desk-clipsum-<id>` result, never as an extra field on `desk-disconnect`:
// `result` is `.strict()`, so an API predating this field would otherwise drop
// the disconnect itself. These pin the accepted shape and its bounds.
describe('desktopCommandResultSchema accepts a clipboard summary', () => {
  const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const envelope = (clipboard: unknown) => ({
    type: 'command_result' as const,
    commandId: `desk-clipsum-${SESSION}`,
    status: 'completed' as const,
    result: { sessionId: SESSION, event: 'clipboard_summary', clipboard },
  });
  const parses = (clipboard: unknown) => desktopCommandResultSchema.safeParse(envelope(clipboard)).success;

  it('accepts the shape the agent sends', () => {
    expect(parses({
      transfers: [
        { direction: 'host_to_viewer', type: 'text', count: 3, bytes: 120 },
        { direction: 'viewer_to_host', type: 'image', count: 1, bytes: 2_000_000 },
      ],
      blocked: 2,
    })).toBe(true);
  });

  it('accepts a summary that is only blocked attempts', () => {
    expect(parses({ transfers: [], blocked: 1 })).toBe(true);
  });

  it('rejects an unknown direction or type', () => {
    expect(parses({ transfers: [{ direction: 'sideways', type: 'text', count: 1, bytes: 1 }], blocked: 0 })).toBe(false);
    expect(parses({ transfers: [{ direction: 'host_to_viewer', type: 'files', count: 1, bytes: 1 }], blocked: 0 })).toBe(false);
  });

  it('rejects negative or fractional counters', () => {
    expect(parses({ transfers: [{ direction: 'host_to_viewer', type: 'text', count: -1, bytes: 1 }], blocked: 0 })).toBe(false);
    expect(parses({ transfers: [], blocked: 1.5 })).toBe(false);
  });

  it('rejects more entries than direction × type allows', () => {
    const entry = { direction: 'host_to_viewer', type: 'text', count: 1, bytes: 1 };
    expect(parses({ transfers: Array(7).fill(entry), blocked: 0 })).toBe(false);
  });

  it('rejects content smuggled in as an extra key', () => {
    expect(parses({ transfers: [], blocked: 0, text: 'the actual clipboard' })).toBe(false);
    expect(parses({ transfers: [{ direction: 'host_to_viewer', type: 'text', count: 1, bytes: 1, text: 'x' }], blocked: 0 })).toBe(false);
  });
});
