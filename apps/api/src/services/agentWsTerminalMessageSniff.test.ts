import { describe, it, expect } from 'vitest';
import { sniffTerminalMessageType, sniffCommandId } from './agentWsTerminalMessageSniff';

describe('sniffTerminalMessageType', () => {
  it('recognizes command_result', () => {
    expect(sniffTerminalMessageType('{"type":"command_result","commandId":"abc-123","status":"success"}')).toBe('command_result');
  });

  it('recognizes update_status', () => {
    expect(sniffTerminalMessageType('{"type":"update_status","targetVersion":"1.2.3"}')).toBe('update_status');
  });

  it('returns null for a non-terminal type (e.g. heartbeat)', () => {
    expect(sniffTerminalMessageType('{"type":"heartbeat"}')).toBeNull();
  });

  it('returns null for unparseable / typeless input', () => {
    expect(sniffTerminalMessageType('not json at all')).toBeNull();
    expect(sniffTerminalMessageType('{}')).toBeNull();
  });

  it('tolerates whitespace variation around the colon', () => {
    expect(sniffTerminalMessageType('{"type"   :   "command_result"}')).toBe('command_result');
  });

  it('ignores a "type":"command_result" substring buried well past the start of an arbitrary/garbage frame', () => {
    // Not valid JSON — the point is that a raw substring scan with no
    // position bound would still find this, wherever it sits in the frame.
    // A well-behaved envelope always carries its `type` key immediately
    // after the opening brace, so a match this far from the start is never
    // a genuine terminal-state message.
    const paddedNoise = 'x'.repeat(2000);
    const buried = `${paddedNoise}"type":"command_result","commandId":"not-a-command"${paddedNoise}`;
    expect(sniffTerminalMessageType(buried)).toBeNull();
  });

  it('ignores a "type":"update_status" substring appearing before the real, differently-typed top-level key', () => {
    // The literal text contains the terminal-state substring ahead of the
    // actual (non-terminal) `type` key — a leftmost-match scan with no
    // anchor to "first key of the object" would pick up the wrong one.
    const embedded = '{"note":"contains ' + '"type":"update_status"' + ' as literal text","type":"heartbeat"}';
    expect(sniffTerminalMessageType(embedded)).toBeNull();
  });

  it('still recognizes a real command_result whose result payload is large (no false negative from the bounded prefix)', () => {
    const largeOutput = 'y'.repeat(50_000);
    const real = JSON.stringify({
      type: 'command_result',
      commandId: 'real-command-id',
      status: 'success',
      result: { output: largeOutput },
    });
    expect(sniffTerminalMessageType(real)).toBe('command_result');
  });
});

describe('sniffCommandId', () => {
  it('extracts commandId when present', () => {
    expect(sniffCommandId('{"type":"command_result","commandId":"cmd-42"}')).toBe('cmd-42');
  });

  it('returns undefined when absent', () => {
    expect(sniffCommandId('{"type":"command_result"}')).toBeUndefined();
  });

  it('never throws on garbage input', () => {
    expect(() => sniffCommandId('\u0000\u0000not json{{{')).not.toThrow();
  });
});
