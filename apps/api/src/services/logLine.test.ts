import { describe, expect, it } from 'vitest';
import { logError, logLine } from './logLine';

describe('logLine', () => {
  it('escapes CR, LF and other control characters so one value stays on one log line', () => {
    const out = logLine('bad gateway\r\n2026-11-26T00:00:00Z [AuthService] login ok\u0000\u001b[31m');
    expect(out).toBe('bad gateway\\r\\n2026-11-26T00:00:00Z [AuthService] login ok\\u0000\\u001b[31m');
    expect(out).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
  });

  it('escapes Unicode line and paragraph separators', () => {
    expect(logLine('a\u2028b\u2029c\u0085d')).toBe('a\\u2028b\\u2029c\\u0085d');
  });

  it('leaves ordinary text, tabs-free punctuation and non-ASCII letters unchanged', () => {
    expect(logLine('HTTP 502: upstream "café" timed out (10s)')).toBe('HTTP 502: upstream "café" timed out (10s)');
  });

  it('stringifies non-string values', () => {
    expect(logLine(42)).toBe('42');
    expect(logLine(undefined)).toBe('undefined');
    expect(logLine(new Error('x\ny'))).toBe('Error: x\\ny');
  });
});

describe('logError', () => {
  it('keeps the stack frames but escapes the attacker-influenced message', () => {
    const error = new Error('upstream said\n    at forged (evil.js:1:1)\n[AuthService] ok');
    const out = logError(error);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Error: upstream said\\n    at forged (evil.js:1:1)\\n[AuthService] ok');
    expect(lines.slice(1).length).toBeGreaterThan(0);
    expect(lines.slice(1).every((line) => /^\s+at /.test(line))).toBe(true);
    expect(out).not.toContain('evil.js:1:1)\n');
  });

  it('handles errors whose stack does not start with the message', () => {
    const error = new Error('a\nb');
    error.stack = 'custom stack\nline two';
    expect(logError(error)).toBe('Error: a\\nb');
  });

  it('falls back to logLine for non-errors', () => {
    expect(logError('plain\nstring')).toBe('plain\\nstring');
    expect(logError({ toString: () => 'obj\r' })).toBe('obj\\r');
  });

  it('includes an escaped cause chain', () => {
    const error = new Error('outer', { cause: new Error('inner\nforged') });
    expect(logError(error).split('\n')[0]).toBe('Error: outer [cause: Error: inner\\nforged]');
  });
});
