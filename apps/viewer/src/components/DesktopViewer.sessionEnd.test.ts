import { describe, it, expect } from 'vitest';
// Source-derived wiring guards (same approach as DesktopViewer.convenience.test.ts):
// the viewer has no React harness. The decisions themselves are unit-tested in
// lib/sessionEnd.test.ts. #10421.
import source from './DesktopViewer.tsx?raw';

function callbackBody(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }, [', start);
  return source.slice(start, end);
}

describe('session ended is terminal (#10421)', () => {
  it('enterSessionEnded stops the reconnect loop and suppresses every auto-reconnect trigger', () => {
    const body = callbackBody('enterSessionEnded');
    expect(body).toContain('userDisconnectRef.current = true');
    expect(body).toContain('stopReconnect()');
    expect(body).toContain("setErrorKind('session_ended')");
    expect(body).toContain("setStatus('error')");
    expect(body).toContain('sessionEndedCardMessage(');
  });

  it('routes every SessionEndedError catch through enterSessionEnded', () => {
    const catches = [...source.matchAll(/if \(err instanceof SessionEndedError\) \{/g)];
    expect(catches.length).toBeGreaterThanOrEqual(2);
    for (const m of catches) {
      const rest = source.slice(m.index!);
      const block = rest.slice(0, rest.indexOf('return;'));
      expect(block, 'SessionEndedError branch must call enterSessionEnded').toMatch(/enterSessionEnded\(/);
      expect(block).not.toContain("setStatus('error')");
    }
  });

  it("ends the viewer's own lease-revoked/lost paths as a terminal session end", () => {
    const at = source.indexOf('const endSession = (message: string) => {');
    expect(at).toBeGreaterThan(-1);
    const fn = source.slice(at, source.indexOf('\n    };', at));
    expect(fn).toContain('enterSessionEnded(message)');
    expect(fn).not.toContain("setStatus('error')");
    expect(source).toContain("onRevoked: (reason) => endSession(sessionEndingText({ reason: 'revoked', detail: reason }))");
  });

  it("handles the agent's session_ending control message before the peer drops", () => {
    const at = source.indexOf("case 'session_ending':");
    expect(at).toBeGreaterThan(-1);
    const branch = source.slice(at, source.indexOf('break;', at));
    expect(branch).toContain('parseSessionEndingMessage(msg)');
    expect(branch).toContain('enterSessionEnded(sessionEndingText(');
  });

  it('offers Retry on the error card only when the card kind allows it', () => {
    const card = source.slice(source.indexOf("{status === 'error' && ("));
    const retry = card.search(/^\s+Retry$/m);
    expect(retry).toBeGreaterThan(-1);
    expect(card.slice(0, retry)).toContain('errorCard.showRetry &&');
    expect(card.slice(0, retry)).toContain('{errorCard.title}');
    expect(card).not.toContain('>Connection Error<');
  });

  it('resets the card kind when a new error is not a session end', () => {
    expect(source).toMatch(/if \(status !== 'error'\) setErrorKind\('error'\)/);
  });
});
