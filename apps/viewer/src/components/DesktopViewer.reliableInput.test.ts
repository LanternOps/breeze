import { describe, it, expect } from 'vitest';
// Source-derived wiring guards (same approach as DesktopViewer.inputSafety.test.ts):
// the viewer has no React harness. The behaviour itself is unit-tested in
// lib/inputSequencer.test.ts and lib/reliableInput.test.ts.
import source from './DesktopViewer.tsx?raw';
import webrtcLib from '../lib/webrtc.ts?raw';
import wsTransport from '../lib/transports/websocket.ts?raw';
import vncTransport from '../lib/transports/vnc.ts?raw';

function body(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }, [', start);
  return source.slice(start, end);
}

describe('DesktopViewer reliable input wiring (W03, #8239)', () => {
  it('sends every WebRTC input event through the router, never raw on the input channel', () => {
    const sender = body('getInputSender');
    expect(sender).toMatch(/reliableInput\.send\(event\)/);
    expect(sender).not.toMatch(/ch\.send\(/);
  });

  it('routes RAF-coalesced mouse moves through the router (they need seq/after in W2b)', () => {
    const flush = body('flushWebRTCMouseMove');
    expect(flush).toMatch(/reliableInput\.send\(\{ type: 'mouse_move', x: pending\.x, y: pending\.y \}\)/);
    expect(flush).not.toMatch(/ch\.send\(/);
  });

  it('flushes stranded releases through the same routed sender', () => {
    const sender = body('getInputSender');
    expect(sender).toMatch(/for \(const ev of stranded\.events\) send\(ev\)/);
  });

  it('keeps the WebSocket path on its own channel, untouched by the sequencer', () => {
    expect(body('getInputSender')).toMatch(/wsSession\.inputChannel\.send\(JSON\.stringify\(event\)\)/);
    for (const src of [wsTransport, vncTransport]) {
      expect(src).not.toMatch(/inputSequencer|reliableInput|input-r/);
    }
  });

  it('feeds the capabilities reply and epoch messages to the router', () => {
    expect(source).toMatch(/reliableInput\.onCapabilities\(inputCapabilitiesRef\.current\.snapshot\(\)\)/);
    expect(source).toMatch(/case 'input_epoch':\s*\n\s*reliableInput\.onControlMessage\(msg\)/);
    const switched = source.slice(source.indexOf("case 'monitor_switched':"), source.indexOf("case 'sas_result':"));
    expect(switched).toMatch(/reliableInput\.onControlMessage\(msg\)/);
  });

  it('sends input_reset after the releases on focus loss', () => {
    const release = body('releaseAllKeys');
    expect(release.match(/reliableInput\.resetHeld\(\)/g)?.length).toBeGreaterThanOrEqual(1);
    const sendLoop = release.indexOf('for (const ev of releases) send(ev)');
    expect(sendLoop).toBeGreaterThan(-1);
    expect(release.indexOf('reliableInput.resetHeld()', sendLoop)).toBeGreaterThan(sendLoop);
  });

  it('forgets input-r when the transport is replaced', () => {
    const connect = source.slice(source.indexOf('webrtcRef.current = sessionWrapper;') - 200, source.indexOf('webrtcRef.current = sessionWrapper;'));
    expect(connect).toMatch(/reliableInput\.detach\(\)/);
    expect(source).toMatch(/inputCapabilitiesRef\.current\.release\(\);\s*\n\s*reliableInput\.detach\(\);/);
  });

  it('gates back/forward and horizontal wheel on the router, not on a guess', () => {
    expect(source.match(/mouseButtonName\(e\.button, \{ extraButtons: reliableInput\.extended\(\)\.extraButtons \}\)/g)).toHaveLength(2);
    expect(source).toMatch(/if \(reliableInput\.extended\(\)\.horizontalWheel\)/);
  });

  it('adds key codes only through extendedKeyFields, gated on the router', () => {
    expect(source.match(/const keyCodes = reliableInput\.extended\(\)\.keyCodes;/g)).toHaveLength(2);
    expect(source.match(/extendedKeyFields\(ne, keyCodes/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toMatch(/code: ne\.code/);
    // Every key_down / key_up / key_press built from a keyboard event carries the gated fields.
    const handlers = source.slice(source.indexOf('const handleKeyDown = useCallback('), source.indexOf('// ── Toolbar: config changes'));
    const keyEvents = handlers.match(/sendInputFn\(\{ type: 'key_(down|up|press)'[^\n]*/g) ?? [];
    expect(keyEvents.length).toBeGreaterThanOrEqual(9);
    for (const line of keyEvents) expect(line).toMatch(/\.\.\.(keyFields|modFields|extendedKeyFields\()/);
  });

  it('leaves the lossy input channel as it is: ordered, maxRetransmits 0', () => {
    expect(webrtcLib).toMatch(/createDataChannel\('input', \{ ordered: true, maxRetransmits: 0 \}\)/);
  });
});
