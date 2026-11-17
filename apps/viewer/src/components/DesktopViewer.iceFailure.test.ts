import { describe, it, expect } from 'vitest';
// Source-derived wiring guards (same approach as DesktopViewer.sessionEnd.test.ts):
// the viewer has no React harness. The decision itself is unit-tested in
// lib/iceFailure.test.ts. #11838.
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
  it('routes a failure of a peer that never connected to the ICE-failure handler, not straight to reconnect', () => {
    const onFailed = handlerBody('connectWebRTC', 'onFailed');
    const neverConnected = onFailed.indexOf('if (!everConnected)');
    expect(neverConnected, 'onFailed must branch on whether this peer ever connected').toBeGreaterThan(-1);
    const branch = onFailed.slice(neverConnected, onFailed.indexOf('return;', neverConnected));
    expect(branch).toContain('handleNeverConnectedIceFailureRef.current(sessionWrapper)');
    expect(branch).not.toContain('startReconnectRef.current()');
    // A peer that did connect and then failed still auto-reconnects.
    expect(onFailed.slice(onFailed.indexOf('return;', neverConnected))).toContain('startReconnectRef.current()');
  });

  it('marks the peer connected and clears the failure count on connect', () => {
    const onConnected = handlerBody('connectWebRTC', 'onConnected');
    expect(onConnected).toContain('everConnected = true');
    expect(onConnected).toContain('neverConnectedIceFailuresRef.current = 0');
  });

  it('stops the loop with a specific error once the decision says so, and otherwise reconnects', () => {
    const body = callbackBody('handleNeverConnectedIceFailure');
    expect(body).toContain('neverConnectedIceFailuresRef.current += 1');
    expect(body).toContain('decideNeverConnectedIceFailure(');
    // Re-checks ownership after the async stats read.
    expect(body).toMatch(/webrtcRef\.current !== wrapper/);
    expect(body).toContain('userDisconnectRef.current');
    const stop = body.slice(body.indexOf('if (decision.stop)'));
    const stopBranch = stop.slice(0, stop.indexOf('return;'));
    expect(stopBranch).toContain('stopReconnect()');
    expect(stopBranch).toContain('wrapper.close()');
    expect(stopBranch).toContain("setStatus('error')");
    expect(stopBranch).toContain('setErrorMessage(decision.message)');
    expect(stopBranch).toContain('onError(decision.message)');
    expect(stop.slice(stop.indexOf('return;'))).toContain('startReconnectRef.current()');
  });

  it('gives every fresh connect and every manual Retry a full failure budget', () => {
    const effect = source.slice(source.indexOf('// ── Connection lifecycle'));
    expect(effect.slice(0, effect.indexOf('async function connect()'))).toContain('neverConnectedIceFailuresRef.current = 0');
    const card = source.slice(source.indexOf("{status === 'error' && ("));
    const retry = card.slice(0, card.search(/^\s+Retry$/m));
    expect(retry).toContain('neverConnectedIceFailuresRef.current = 0');
  });
});
