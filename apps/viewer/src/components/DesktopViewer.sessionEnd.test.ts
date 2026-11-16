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

describe('reconnect announces itself before closing the old peer (#10542)', () => {
  it('attemptReconnect awaits announceViewerReconnect before it closes the old WebRTC peer', () => {
    const body = callbackBody('attemptReconnect');
    const announce = body.indexOf('await announceViewerReconnect(auth)');
    const close = body.indexOf('oldRtc?.close()');
    expect(announce, 'announceViewerReconnect call').toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(-1);
    expect(announce).toBeLessThan(close);
    // Marked in flight before the await, so an interval tick cannot start a
    // second attempt meanwhile.
    expect(body.indexOf('reconnectInFlightRef.current = true')).toBeLessThan(announce);
  });
});

// #11931: a hang-up records operator_ended instead of peer_disconnected. The
// End request goes out BEFORE the peer is closed (and the window is closed),
// so it is not cut off and it lands before the agent reports the peer drop.
describe('hang-up ends the session as the operator (#11931)', () => {
  it('handleDisconnect sends End before it closes the transports and the window', () => {
    const body = callbackBody('handleDisconnect');
    const end = body.indexOf('hangUpRef.current(');
    expect(end, 'handleDisconnect must send End').toBeGreaterThan(-1);
    for (const later of ['rtcSession?.close()', 'vncSession?.close()', 'wsCleanup?.()', 'onDisconnect()']) {
      const at = body.indexOf(later);
      expect(at, `${later} not found`).toBeGreaterThan(-1);
      expect(at, `${later} must run after End is sent`).toBeGreaterThan(end);
    }
    // A second click while End is in flight must not tear down twice.
    expect(body).toContain('hangingUpRef.current');
  });

  it('closing the window sends End first and never blocks the close on it', () => {
    const at = source.indexOf('.onCloseRequested(');
    expect(at, 'the session window must listen for close requests').toBeGreaterThan(-1);
    const handler = source.slice(at, source.indexOf('\n    });', at));
    expect(handler).toContain('hangUpRef.current(authRef.current)');
    // Tauri only destroys the window after the handler resolves; it must not
    // prevent the close.
    expect(handler).not.toContain('preventDefault');
  });
});
