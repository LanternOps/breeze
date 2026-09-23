/**
 * A-W05 (D13b / Q5) — `redactForCapture` is the ONLY thing standing between the
 * org-downloadable artifact store and a captured password/token/api key. It
 * must wipe secrets from both a JSON payload (key-name denylist, walked into
 * nested rows) and a plain-text payload (pattern-based), and it must not
 * mangle a JSON payload that has nothing to redact.
 */
import { describe, expect, it } from 'vitest';
import { redactForCapture } from './captureRedaction';

describe('redactForCapture — JSON payloads', () => {
  it('wipes a top-level and a nested-row secret field by key name', () => {
    const raw = JSON.stringify({
      password: 'hunter2',
      rows: [
        { id: 1, apiKey: 'sk-live-1', note: 'fine' },
        { id: 2, token: 'tok-abc', note: 'also fine' },
      ],
    });
    const out = redactForCapture(raw);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('sk-live-1');
    expect(out).not.toContain('tok-abc');
    const parsed = JSON.parse(out) as { rows: Array<{ id: number; note: string }> };
    // Redaction blanks the sensitive FIELD, not the row: shape and count survive.
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]!.note).toBe('fine');
  });

  it('round-trips a JSON payload with nothing sensitive in it byte-for-byte (modulo JSON.stringify normalization)', () => {
    const raw = JSON.stringify({ devices: [{ id: 'd1', name: 'web-01' }], total: 1 });
    expect(redactForCapture(raw)).toBe(raw);
  });

  it('scrubs an embedded identifier inside an error-shaped string field, matching the chat path', () => {
    const raw = JSON.stringify({ error: 'failed for user DOMAIN\\jsmith' });
    const out = redactForCapture(raw);
    expect(out).not.toContain('DOMAIN\\jsmith');
  });
});

describe('redactForCapture — plain-text payloads', () => {
  it('falls back to text redaction for a non-JSON string and still wipes a bare secret', () => {
    const raw = 'connecting with tok=sk-ant-abcdefghijklmnopqrstuv done';
    const out = redactForCapture(raw);
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuv');
  });

  it('leaves ordinary text untouched', () => {
    const raw = 'HEAD' + 'm'.repeat(1000) + 'TAIL';
    expect(redactForCapture(raw)).toBe(raw);
  });
});
