import { describe, it, expect } from 'vitest';
import { stripAnsi, commandOutputExcerpt } from './commandOutput';

const ESC = '\u001b';

describe('stripAnsi', () => {
  it('removes SGR colour sequences (ctrld output, #10307)', () => {
    const raw = `${ESC}[90m2026-10-26T14:03:11Z${ESC}[0m ${ESC}[31mERR${ESC}[0m failed to provision ${ESC}[1;31mInvalid provisioning code${ESC}[0m`;
    expect(stripAnsi(raw)).toBe('2026-10-26T14:03:11Z ERR failed to provision Invalid provisioning code');
  });

  it('removes cursor/erase CSI sequences and OSC titles', () => {
    expect(stripAnsi(`a${ESC}[2Kb${ESC}[1Ac${ESC}]0;title${ESC}\\d${ESC}]0;t2\u0007e`)).toBe('abcde');
  });

  it('removes 8-bit CSI and stray control characters but keeps newlines and tabs', () => {
    expect(stripAnsi('x\u009b31my\u0000z\u0007\tq\r\nw')).toBe('xyz\tq\nw');
  });

  it('removes caret-notation SGR left behind by a terminal capture', () => {
    expect(stripAnsi('^[[90mtime^[[0m ^[[31mERR^[[0m boom')).toBe('time ERR boom');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('C:\\ControlD\\ctrld.exe exited [code 33]')).toBe('C:\\ControlD\\ctrld.exe exited [code 33]');
  });
});

describe('commandOutputExcerpt', () => {
  it('returns null for empty, whitespace-only or escape-only output', () => {
    expect(commandOutputExcerpt(null)).toBeNull();
    expect(commandOutputExcerpt(undefined)).toBeNull();
    expect(commandOutputExcerpt('  \n\n ')).toBeNull();
    expect(commandOutputExcerpt(`${ESC}[0m\n${ESC}[31m${ESC}[0m`)).toBeNull();
  });

  it('keeps the LAST lines, where a vendor tool prints its failure', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const excerpt = commandOutputExcerpt(lines.join('\n'), { maxLines: 3 });
    expect(excerpt).toEqual({ text: 'line 18\nline 19\nline 20', truncated: true });
  });

  it('drops blank lines and strips ANSI before choosing lines', () => {
    const raw = `${ESC}[90mINF${ESC}[0m starting\n\n${ESC}[31mERR${ESC}[0m Invalid provisioning code\n\n`;
    expect(commandOutputExcerpt(raw)).toEqual({
      text: 'INF starting\nERR Invalid provisioning code',
      truncated: false,
    });
  });

  it('bounds the excerpt by characters, keeping the tail', () => {
    const excerpt = commandOutputExcerpt(`${'a'.repeat(50)}\n${'b'.repeat(50)}`, { maxChars: 20 });
    expect(excerpt?.truncated).toBe(true);
    expect(excerpt?.text.length).toBeLessThanOrEqual(20);
    expect(excerpt?.text.endsWith('b'.repeat(19))).toBe(true);
    expect(excerpt?.text.startsWith('…')).toBe(true);
  });

  it('applies default bounds', () => {
    const excerpt = commandOutputExcerpt('x'.repeat(5000));
    expect(excerpt?.truncated).toBe(true);
    expect(excerpt!.text.length).toBeLessThanOrEqual(600);
  });
});
