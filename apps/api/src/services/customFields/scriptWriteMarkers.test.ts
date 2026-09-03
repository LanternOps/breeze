import { describe, it, expect } from 'vitest';
import { extractCustomFieldWrites, CUSTOM_FIELD_MARKER } from './scriptWriteMarkers';

const marker = (json: string) => `${CUSTOM_FIELD_MARKER} ${json}`;

describe('extractCustomFieldWrites', () => {
  it('returns nothing for ordinary stdout', () => {
    const out = extractCustomFieldWrites('hello\nworld\n', undefined);
    expect(out.channel).toBe('none');
    expect(out.candidates.size).toBe(0);
    expect(out.failures).toEqual([]);
  });

  it('extracts one marker line and leaves surrounding output alone', () => {
    const out = extractCustomFieldWrites(
      `scanning...\n${marker('{"ram_slot_type":"DDR5-5600"}')}\ndone\n`,
      undefined,
    );
    expect(out.channel).toBe('stdout');
    expect(Object.fromEntries(out.candidates)).toEqual({ ram_slot_type: 'DDR5-5600' });
  });

  it('tolerates leading/trailing whitespace and CRLF line endings', () => {
    const out = extractCustomFieldWrites(`  ${marker('{"a":1}')}  \r\n`, undefined);
    expect(Object.fromEntries(out.candidates)).toEqual({ a: 1 });
  });

  it('lets a later marker line win for the same key', () => {
    const out = extractCustomFieldWrites(`${marker('{"a":1}')}\n${marker('{"a":2,"b":3}')}`, undefined);
    expect(Object.fromEntries(out.candidates)).toEqual({ a: 2, b: 3 });
  });

  it('reports an unparseable marker instead of dropping it silently', () => {
    const out = extractCustomFieldWrites(marker('{"a":'), undefined);
    expect(out.candidates.size).toBe(0);
    expect(out.failures[0]?.reason).toBe('marker_unparseable');
  });

  it('reports a marker mangled by the secret sanitizer', () => {
    // What SanitizeOutput does to `{"api_token":"abcdefgh"}`.
    const out = extractCustomFieldWrites(marker('{"api_token=[REDACTED]"}'), undefined);
    expect(out.failures[0]?.reason).toBe('marker_unparseable');
  });

  it('rejects a marker whose payload is not a plain object', () => {
    expect(extractCustomFieldWrites(marker('[1,2]'), undefined).failures[0]?.reason).toBe('marker_unparseable');
    expect(extractCustomFieldWrites(marker('"x"'), undefined).failures[0]?.reason).toBe('marker_unparseable');
  });

  it('caps the number of marker lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => marker(`{"k${i}":1}`)).join('\n');
    const out = extractCustomFieldWrites(lines, undefined);
    expect(out.candidates.size).toBe(20);
    expect(out.failures.some((f) => f.reason === 'too_many_lines')).toBe(true);
  });

  it('caps the number of distinct keys', () => {
    const pairs = Array.from({ length: 60 }, (_, i) => `"k${i}":1`).join(',');
    const out = extractCustomFieldWrites(marker(`{${pairs}}`), undefined);
    expect(out.candidates.size).toBe(50);
    expect(out.failures.some((f) => f.reason === 'too_many_keys')).toBe(true);
  });

  it('rejects an oversized marker line', () => {
    const out = extractCustomFieldWrites(marker(`{"a":"${'x'.repeat(9000)}"}`), undefined);
    expect(out.candidates.size).toBe(0);
    expect(out.failures[0]?.reason).toBe('marker_too_large');
  });

  it('reads the versioned envelope and prefers it over stdout', () => {
    const out = extractCustomFieldWrites(marker('{"from":"stdout"}'), {
      customFieldWrites: { schemaVersion: 1, fields: { from: 'envelope' } },
    });
    expect(out.channel).toBe('envelope');
    expect(Object.fromEntries(out.candidates)).toEqual({ from: 'envelope' });
  });

  it('ignores an envelope with the wrong schemaVersion and falls back to stdout', () => {
    const out = extractCustomFieldWrites(marker('{"from":"stdout"}'), {
      customFieldWrites: { schemaVersion: 2, fields: { from: 'envelope' } },
    });
    expect(out.channel).toBe('stdout');
    expect(Object.fromEntries(out.candidates)).toEqual({ from: 'stdout' });
  });

  it('ignores a bare customFields key on a whole-JSON stdout reparse', () => {
    // toWSCommandResult reparses whole-JSON stdout into `result`; an
    // unnamespaced key there must NOT be read as a write-back.
    const out = extractCustomFieldWrites('{"customFields":{"a":1}}', { customFields: { a: 1 } });
    expect(out.channel).toBe('none');
    expect(out.candidates.size).toBe(0);
  });

  it('ignores inherited Object.prototype keys in an envelope payload', () => {
    const out = extractCustomFieldWrites(undefined, {
      customFieldWrites: { schemaVersion: 1, fields: JSON.parse('{"__proto__":{"polluted":1},"ok":"v"}') },
    });
    expect(Object.fromEntries(out.candidates)).toEqual({ ok: 'v' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores a __proto__ key in a stdout marker payload', () => {
    const out = extractCustomFieldWrites(marker('{"__proto__":{"polluted":1},"ok":"v"}'), undefined);
    expect(Object.fromEntries(out.candidates)).toEqual({ ok: 'v' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
