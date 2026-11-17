import { describe, it, expect } from 'vitest';
// Source-derived wiring guards (same approach as DesktopViewer.sessionEnd.test.ts):
// the viewer has no React harness. The behaviour (a connected session keeps
// re-offering; a never-connected one stops on its second failure; resets;
// the macOS handoff decision) is driven through IceFailureBudget and
// neverConnectedStopStep in lib/iceFailure.test.ts. These guards pin that
// DesktopViewer routes through them. #11838.
import source from './DesktopViewer.tsx?raw';

function callbackBody(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }, [', start);
  return source.slice(start, end);
}

function handlerBody(callbackName: string, handler: string): string {
  const body = callbackBody(callbackName);
  const at = body.indexOf(`${handler}: () => {`);
  expect(at, `${handler} not found in ${callbackName}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf('\n        },', at));
}

describe('a WebRTC peer that never connects does not re-offer forever (#11838)', () => {
  it('routes every peer failure through the session-level budget', () => {
    const onFailed = handlerBody('connectWebRTC', 'onFailed');
    expect(onFailed).toContain('handlePeerFailedRef.current(sessionWrapper)');
    // The budget decides between reconnect and diagnose; onFailed must not
    // bypass it, and no per-peer flag may decide it.
    expect(onFailed).not.toContain('startReconnectRef.current()');
    expect(source).not.toMatch(/\beverConnected\b/);
    expect(source).not.toContain('neverConnectedIceFailuresRef');
  });

  it('marks the session connected when a peer connects', () => {
    expect(handlerBody('connectWebRTC', 'onConnected')).toContain('iceBudgetRef.current.peerConnected()');
  });

  it('re-checks ownership after the candidate read, and reconnects or stops', () => {
    const body = callbackBody('handlePeerFailed');
    expect(body).toContain('iceBudgetRef.current.peerFailed(');
    expect(body).toContain('webrtcRef.current === wrapper');
    expect(body).toContain('userDisconnectRef.current');
    expect(body).toContain('cancelledRef.current');
    const reconnect = body.slice(body.indexOf('reconnect:'), body.indexOf('stop:'));
    expect(reconnect).toContain('startReconnectRef.current()');
    const stop = body.slice(body.indexOf('stop:'));
    expect(stop).toContain('stopReconnect()');
    expect(stop).toContain("setStatus('error')");
    expect(stop).toContain('setErrorMessage(decision.message)');
    expect(stop).toContain('onError(decision.message)');
    // Released before close(), or onClosed would overwrite the error card
    // with 'disconnected'.
    expect(stop.indexOf('webrtcRef.current = null')).toBeGreaterThan(-1);
    expect(stop.indexOf('webrtcRef.current = null')).toBeLessThan(stop.indexOf('wrapper.close()'));
  });

  it('hands a macOS device off to VNC before showing the error card, like the reconnect deadline', () => {
    const stop = callbackBody('handlePeerFailed').slice(callbackBody('handlePeerFailed').indexOf('stop:'));
    const step = stop.indexOf('neverConnectedStopStep(');
    expect(step, 'the stop must take the same handoff decision as the deadline path').toBeGreaterThan(-1);
    expect(stop.slice(step)).toContain('remoteOs');
    expect(stop.slice(step)).toContain('lastUserTransportChoiceAtRef.current');
    const handoff = stop.slice(stop.indexOf("'handoff_to_vnc'"));
    const handoffBranch = handoff.slice(0, handoff.indexOf('return;'));
    expect(handoffBranch).toContain("switchTransportRef.current('vnc', 'auto')");
    // Recorded before the switch, so the VNC poll cannot hand straight back.
    expect(handoffBranch).toContain('iceBudgetRef.current.handedOffToVnc()');
    expect(handoffBranch.indexOf('iceBudgetRef.current.handedOffToVnc()'))
      .toBeLessThan(handoffBranch.indexOf("switchTransportRef.current('vnc', 'auto')"));
    // The error card comes only after the handoff check.
    expect(stop.indexOf("setStatus('error')")).toBeGreaterThan(stop.indexOf("'handoff_to_vnc'"));
    // The loop is stopped either way.
    expect(stop.indexOf('stopReconnect()')).toBeLessThan(step);
  });

  it('starts a new session budget on every connect effect run (fresh connect and reused window)', () => {
    const effect = source.slice(source.indexOf('// ── Connection lifecycle'));
    expect(effect.slice(0, effect.indexOf('async function connect()'))).toContain('iceBudgetRef.current.newSession()');
    expect(source.match(/iceBudgetRef\.current\.newSession\(\)/g)).toHaveLength(1);
  });

  it('gates the automatic VNC→WebRTC handoff on the budget, so a never-connected path does not cycle', () => {
    const at = source.indexOf('shouldAutoHandoffToWebRTC({');
    expect(at).toBeGreaterThan(-1);
    const condition = source.slice(source.lastIndexOf('if (', at), at);
    expect(condition).toContain('iceBudgetRef.current.autoWebRTCHandoffAllowed');
  });

  it('resets the failure count on a transport switch and on manual Retry, never on the reconnect path', () => {
    const switchBody = callbackBody('switchTransport');
    const userChoice = switchBody.indexOf('iceBudgetRef.current.userChoseTransport()');
    const reset = switchBody.indexOf('iceBudgetRef.current.resetFailures()');
    expect(userChoice, 'a manual switch lifts the handoff suppression and resets the count').toBeGreaterThan(-1);
    expect(reset, 'an automatic switch must not inherit a leftover count').toBeGreaterThan(-1);
    // Only once the switch is really going ahead.
    expect(userChoice).toBeGreaterThan(switchBody.indexOf('if (!auth) return;'));
    expect(reset).toBeGreaterThan(switchBody.indexOf('if (!auth) return;'));
    expect(switchBody.slice(switchBody.lastIndexOf('if (', userChoice), userChoice)).toContain("reason === 'user'");
    const card = source.slice(source.indexOf("{status === 'error' && ("));
    const retry = card.slice(0, card.search(/^\s+Retry$/m));
    expect(retry).toContain('iceBudgetRef.current.resetFailures()');
    // Exactly those two resets; the reconnect loop never resets (that was the loop).
    expect(source.match(/iceBudgetRef\.current\.resetFailures\(\)/g)).toHaveLength(2);
    expect(callbackBody('startReconnect')).not.toContain('iceBudgetRef');
    expect(callbackBody('attemptReconnect')).not.toContain('iceBudgetRef');
  });
});
