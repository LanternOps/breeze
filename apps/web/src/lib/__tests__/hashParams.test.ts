import { describe, expect, it } from 'vitest';
import { parseHashGrammar, writeHashKeys } from '../hashParams';

describe('parseHashGrammar', () => {
  it('parses tab, selection, params', () => {
    expect(parseHashGrammar('#cves/abc&status=open&severity=critical,high', ['cves', 'software'])).toEqual({
      tab: 'cves',
      selection: 'abc',
      params: { status: ['open'], severity: ['critical', 'high'] },
    });
  });

  it('bare filter hash with no tab', () => {
    const p = parseHashGrammar('#status=active', ['cves']);
    expect(p.tab).toBeNull();
    expect(p.selection).toBeNull();
    expect(p.params).toEqual({ status: ['active'] });
  });

  it('tab with no params keeps existing bookmarks resolving', () => {
    expect(parseHashGrammar('#patches', ['patches', 'compliance'])).toEqual({
      tab: 'patches',
      selection: null,
      params: {},
    });
    expect(parseHashGrammar('#cves/some%2Fid', ['cves']).selection).toBe('some/id');
  });

  it('unknown keys and empty values are ignored without throwing', () => {
    expect(() => parseHashGrammar('#&=&&x', [])).not.toThrow();
    const p = parseHashGrammar('#&=&&x&y=&z=1', []);
    expect(p.params).toEqual({ z: ['1'] });
  });

  it('empty and invalid-escape input does not throw', () => {
    expect(parseHashGrammar('', ['a']).tab).toBeNull();
    expect(() => parseHashGrammar('#k=%E0%A4%A', [])).not.toThrow();
  });

  it('decodes values and drops empty list members', () => {
    expect(parseHashGrammar('#k=a%20b,,c', []).params).toEqual({ k: ['a b', 'c'] });
  });
});

describe('writeHashKeys', () => {
  it('preserves keys it does not own', () => {
    const out = writeHashKeys('#hideAiNoise=1&severity=low', { severity: ['high'] }, []);
    expect(out).toContain('hideAiNoise=1');
    expect(out).toContain('severity=high');
    expect(out).not.toContain('severity=low');
  });

  it('null deletes an owned key', () => {
    const out = writeHashKeys('#hideAiNoise=1&severity=low', { severity: null }, []);
    expect(out).toBe('#hideAiNoise=1');
  });

  it('preserves the tab and selection', () => {
    const out = writeHashKeys('#cves/abc&status=open', { status: ['closed'] }, ['cves']);
    expect(out).toBe('#cves/abc&status=closed');
  });

  it('returns empty string when nothing remains', () => {
    expect(writeHashKeys('#severity=low', { severity: null }, [])).toBe('');
  });

  it('multi-value joins with commas', () => {
    expect(writeHashKeys('', { severity: ['critical', 'high'] }, [])).toBe('#severity=critical,high');
  });
});

describe('parseHashGrammar prototype safety', () => {
  const hostile = [
    '#__proto__[polluted]=1',
    '#__proto__=1,2',
    '#constructor.prototype.x=1',
    '#constructor=1&prototype=2&status=open',
    '#cves/abc&__proto__=polluted',
  ];

  it.each(hostile)('%s neither throws nor pollutes Object.prototype', (hash) => {
    let p!: ReturnType<typeof parseHashGrammar>;
    expect(() => {
      p = parseHashGrammar(hash, ['cves']);
    }).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(p.params)).toBeNull();
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.keys(p.params)).not.toContain(bad);
    }
  });

  it('still parses normal keys next to forbidden ones', () => {
    const p = parseHashGrammar('#__proto__=x&constructor=y&status=open', []);
    expect(p.params.status).toEqual(['open']);
    expect(Object.keys(p.params)).toEqual(['status']);
  });
});
