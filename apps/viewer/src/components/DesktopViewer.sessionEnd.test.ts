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
  // The ordering itself (End settles before any close, a throwing close cannot
  // keep the window open, a stale continuation leaves a reused window alone) is
  // tested by behaviour in lib/sessionHangUp.test.ts (#12129). These guard that
  // handleDisconnect runs that sequence with its inputs wired correctly.
  it('handleDisconnect runs the hang-up sequence with every transport as a closer', () => {
    const body = callbackBody('handleDisconnect');
    expect(body).toContain('hangUpThenClose({');
    expect(body).toContain('onDone: onDisconnect');
    // Each transport is handed over as a closer (a function the sequence calls
    // after End), never closed directly.
    expect(body).toContain("closers.push(['WebSocket session', wsCleanup])");
    expect(body).toContain("closers.push(['WebRTC session', () => rtcSession.close()])");
    expect(body).toContain("closers.push(['VNC session', () => vncSession.close()])");
    expect(body).toMatch(/closers\.push\(\['VNC tunnel', \(\) => \{\s+void closeTunnel\(/);
    const beforeClosers = body.slice(0, body.indexOf('const closers'));
    for (const early of ['.close()', 'wsCleanup()', 'closeTunnel(', 'onDisconnect()']) {
      expect(beforeClosers, `${early} must not run before End`).not.toContain(early);
    }
    expect(body).not.toContain('onDisconnect()');
    // A second click while End is in flight must not tear down twice.
    expect(body).toMatch(/if \(hangingUpRef\.current\) return;\s+hangingUpRef\.current = true;/);
  });

  it('a stale hang-up cannot close a window reused for a newer session (#12129)', () => {
    const body = callbackBody('handleDisconnect');
    expect(body).toMatch(/const generation = sessionGenerationRef\.current;/);
    expect(body).toContain('isCurrent: () => sessionGenerationRef.current === generation');
    // Every connect effect run (a new session, or a deep link reusing the
    // window) starts a new generation and clears the in-flight hang-up.
    const effect = source.slice(source.indexOf('// Per-invocation cancel flag.'));
    const reset = effect.slice(0, effect.indexOf('stopReconnect();'));
    expect(reset).toContain('sessionGenerationRef.current += 1;');
    expect(reset).toContain('hangingUpRef.current = false;');
  });

  // #12129: Rust owns the window close (src-tauri/src/session_end.rs), so a
  // hung page can still close and the hang-up is still recorded.
  it('leaves the window close to the native hook instead of a page listener', () => {
    // A page close listener makes Tauri hold every close until the page
    // destroys the window, which a hung page never does.
    expect(source).not.toContain('.onCloseRequested(');
    expect(source).toContain("listen('session-window-closing'");
  });

  it('every auth the viewer adopts is reported to the native close hook', () => {
    const assignments = [...source.matchAll(/authRef\.current = (.+)/g)].map((m) => m[1]);
    expect(assignments.length).toBeGreaterThanOrEqual(5);
    for (const rhs of assignments) {
      expect(rhs, `authRef assignment must go through nativeSessionEnd.track: ${rhs}`).toMatch(/^nativeSessionEndRef\.current\.track\(/);
    }
  });

  it('handleDisconnect disarms the native End after sending its own, before closing the window', () => {
    const body = callbackBody('handleDisconnect');
    expect(body).toMatch(/hangUp: async \(\) => \{\s+await hangUpRef\.current\(auth\);\s+await nativeSessionEndRef\.current\.disarm\(auth\?\.sessionId\);\s+\}/);
  });
});
