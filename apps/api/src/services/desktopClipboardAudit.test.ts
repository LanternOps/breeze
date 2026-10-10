import { describe, it, expect, vi } from 'vitest';
import { recordDesktopClipboardSummary, type DesktopClipboardAuditDeps } from './desktopClipboardAudit';

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const summary = {
  transfers: [{ direction: 'host_to_viewer' as const, type: 'text' as const, count: 2, bytes: 40 }],
  blocked: 1,
};

function deps(overrides: Partial<DesktopClipboardAuditDeps> = {}): DesktopClipboardAuditDeps {
  return {
    findSession: vi.fn(async () => ({ orgId: 'org-1', userId: 'user-1' })),
    writeAuditOnce: vi.fn(async () => true),
    ...overrides,
  };
}

describe('recordDesktopClipboardSummary', () => {
  it('writes one session_clipboard_summary row attributed to the reporting agent', async () => {
    const d = deps();
    const out = await recordDesktopClipboardSummary({ sessionId: SESSION, deviceId: 'device-1', clipboard: summary }, d);

    expect(out).toBe('recorded');
    expect(d.findSession).toHaveBeenCalledWith(SESSION, 'device-1');
    expect(d.writeAuditOnce).toHaveBeenCalledWith('device-1', 'org-1', {
      sessionId: SESSION,
      clipboard: summary,
      sessionOwnerId: 'user-1',
      deviceId: 'device-1',
      reportedBy: 'authenticated_agent',
    });
  });

  it('names the segment, so each agent Session of one server session gets its own row', async () => {
    // A WebRTC reconnect, Retry or session switch reuses the remote_sessions
    // row with a new agent Session, which reports at its own teardown. The
    // writer dedupes per (session, segment): a resend is dropped, a second
    // segment is not.
    const d = deps();
    const segmentId = 'ab'.repeat(16);
    await recordDesktopClipboardSummary({ sessionId: SESSION, deviceId: 'device-1', clipboard: { ...summary, segmentId } }, d);
    expect(d.writeAuditOnce).toHaveBeenCalledWith('device-1', 'org-1', expect.objectContaining({ sessionId: SESSION, segmentId }));
  });

  it('writes nothing for a session that is not on the reporting device', async () => {
    const d = deps({ findSession: vi.fn(async () => null) });
    expect(await recordDesktopClipboardSummary({ sessionId: SESSION, deviceId: 'device-2', clipboard: summary }, d)).toBe('unknown_session');
    expect(d.writeAuditOnce).not.toHaveBeenCalled();
  });

  it('writes nothing when the summary was already recorded (outbox resend)', async () => {
    // The writer decides atomically (one transaction under a per-session
    // advisory lock) whether a row already exists; two concurrent copies of
    // the same report must not both insert.
    const d = deps({ writeAuditOnce: vi.fn(async () => false) });
    expect(await recordDesktopClipboardSummary({ sessionId: SESSION, deviceId: 'device-1', clipboard: summary }, d)).toBe('duplicate');
  });

  it('writes nothing for an empty summary', async () => {
    const d = deps();
    expect(await recordDesktopClipboardSummary({ sessionId: SESSION, deviceId: 'device-1', clipboard: { transfers: [], blocked: 0 } }, d)).toBe('empty');
    expect(d.findSession).not.toHaveBeenCalled();
    expect(d.writeAuditOnce).not.toHaveBeenCalled();
  });
});
