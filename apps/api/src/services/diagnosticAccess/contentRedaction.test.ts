import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_REDACTION_CONTEXT_BYTES,
  diagnosticReadWindow,
  redactDiagnosticWindow,
} from './contentRedaction';

const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'.repeat(4);
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----\n`;
const FILE = Buffer.from(
  [
    'startup ok',
    'db_password=Hunter2Hunter2',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'aws key AKIAABCDEFGHIJKLMNOP',
    PEM,
    'shutdown ok',
    '',
  ].join('\n'),
  'utf8',
);

/** What the tool returns for a model read of [offset, offset+maxBytes) of `file`. */
function readAs(file: Buffer, offset: number, maxBytes: number) {
  const w = diagnosticReadWindow(offset, maxBytes);
  const window = file.subarray(w.offset, w.offset + w.maxBytes);
  return redactDiagnosticWindow(window, offset - w.offset, maxBytes);
}

const SECRETS = ['Hunter2Hunter2', 'abcdefghijklmnopqrstuvwxyz012345', 'AKIAABCDEFGHIJKLMNOP', PEM_BODY.slice(0, 24)];

describe('diagnosticReadWindow', () => {
  it('asks the device for context on both sides of the requested range', () => {
    const C = DIAGNOSTIC_REDACTION_CONTEXT_BYTES;
    expect(diagnosticReadWindow(0, 100)).toEqual({ offset: 0, maxBytes: 100 + C });
    expect(diagnosticReadWindow(C * 3, 100)).toEqual({ offset: C * 2, maxBytes: C + 100 + C });
    expect(diagnosticReadWindow(10, 100)).toEqual({ offset: 0, maxBytes: 10 + 100 + C });
  });
});

describe('redactDiagnosticWindow', () => {
  it('redacts every secret in a whole-file read and keeps the rest', () => {
    const out = readAs(FILE, 0, FILE.length).bytes.toString('utf8');
    expect(out).toContain('startup ok');
    expect(out).toContain('shutdown ok');
    for (const s of SECRETS) expect(out).not.toContain(s);
  });

  it('a read that starts just after the key name still redacts the value', () => {
    const at = FILE.indexOf('Hunter2');
    for (const len of [1, 7, 14, 64]) {
      const r = readAs(FILE, at, len);
      expect(r.bytes.toString('latin1')).not.toMatch(/Hunter|unter2|2Hunt/);
      expect(r.redacted).toBe(true);
    }
  });

  it('a read inside a private key body, past its header, still redacts it', () => {
    const at = FILE.indexOf(PEM_BODY) + 40;
    const r = readAs(FILE, at, 60);
    expect(r.bytes.toString('latin1')).not.toMatch(/[A-Za-z0-9+/]{12,}/);
    expect(r.redacted).toBe(true);
  });

  it('a private key body far from its header is still caught by its END line', () => {
    const body = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(800); // ~28 KiB, longer than the context
    const big = Buffer.from(`log line\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\ntail\n`, 'utf8');
    const at = big.indexOf('-----END') - 200;
    const r = readAs(big, at, 100);
    expect(r.bytes.toString('latin1')).not.toMatch(/QUJDREVG|R0hJSktM/);
    expect(r.redacted).toBe(true);
  });

  it('pages a file in small chunks without ever returning a secret fragment', () => {
    let joined = '';
    for (let off = 0; off < FILE.length; off += 5) joined += readAs(FILE, off, 5).bytes.toString('latin1');
    for (const s of SECRETS) expect(joined).not.toContain(s.slice(0, 6));
    expect(joined).toContain('startup ok');
  });

  it('redacts UTF-16LE text', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ok\r\npassword=Hunter2Hunter2\r\ndone\r\n', 'utf16le')]);
    const r = readAs(utf16, 0, utf16.length);
    expect(r.bytes.toString('utf16le')).not.toContain('Hunter2');
    expect(r.redacted).toBe(true);
    // Odd-aligned page into the value.
    const at = utf16.indexOf(Buffer.from('Hunter2', 'utf16le')) + 1;
    const r2 = readAs(utf16, at, 9);
    expect(r2.bytes.toString('latin1').replace(/\0/g, '')).not.toMatch(/unter|Hunt/);
  });

  it('returns bytes without secrets unchanged, and exactly the requested range', () => {
    const bin = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 10, 65, 66, 67]);
    const r = readAs(bin, 3, 6);
    expect(r.redacted).toBe(false);
    expect([...r.bytes]).toEqual([250, 251, 252, 253, 254, 255]);
    const text = Buffer.from('line1\nline2 ☃\n', 'utf8');
    expect(readAs(text, 0, text.length).bytes.equals(text)).toBe(true);
  });

  it('a range past the end of the window is empty', () => {
    const r = redactDiagnosticWindow(Buffer.from('abc'), 10, 5);
    expect(r.bytes.length).toBe(0);
    expect(r.redacted).toBe(false);
  });
});
