import { describe, it, expect } from 'vitest';
import {
  describeEndpointUrl,
  findDisplayPlaceholderPath,
  presentEndpointTarget,
  resolveEndpointTargetInput,
  resolveHeaderValuesInput,
  scrubUrlsInText,
} from './endpointDisplay';

describe('describeEndpointUrl', () => {
  it('keeps only scheme + host and fingerprints the full URL', () => {
    const a = describeEndpointUrl('https://hooks.example.com/services/T1/B1/abc123');
    const b = describeEndpointUrl('https://hooks.example.com/services/T1/B1/def456');
    expect(a.url).toBe('https://hooks.example.com');
    expect(a.fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('keeps a non-default port and drops userinfo and query', () => {
    expect(describeEndpointUrl('https://u:pw@status.example.com:8443/x?token=t').url)
      .toBe('https://status.example.com:8443');
  });

  it('returns a placeholder for unparseable or opaque values', () => {
    expect(describeEndpointUrl('not a url')).toEqual({ url: '[invalid-url]', fingerprint: null });
    expect(describeEndpointUrl('mailto:a@example.com')).toEqual({ url: '[invalid-url]', fingerprint: null });
  });
});

describe('presentEndpointTarget', () => {
  it('leaves plain hosts, IPs and host:port untouched', () => {
    expect(presentEndpointTarget('10.0.0.1')).toEqual({ target: '10.0.0.1', fingerprint: null });
    expect(presentEndpointTarget('db.internal:5432')).toEqual({ target: 'db.internal:5432', fingerprint: null });
    expect(presentEndpointTarget('[fe80::1]')).toEqual({ target: '[fe80::1]', fingerprint: null });
  });

  it('reduces a URL target to its origin', () => {
    const view = presentEndpointTarget('https://user:pw@api.example.com/health?key=abc');
    expect(view.target).toBe('https://api.example.com');
    expect(view.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });

  it('strips userinfo, path and query from a scheme-less target', () => {
    const view = presentEndpointTarget('user:pw@api.example.com/health?key=abc');
    expect(view.target).toBe('api.example.com');
    expect(view.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('scrubUrlsInText', () => {
  it('reduces a URL inside a Go client error to its origin', () => {
    const text = 'Get "https://user:pw@api.example.com/v1/status?token=abc": dial tcp 1.2.3.4:443: i/o timeout';
    const out = scrubUrlsInText(text);
    expect(out).toBe('Get "https://api.example.com": dial tcp 1.2.3.4:443: i/o timeout');
  });

  it('handles several URLs and unquoted URLs', () => {
    const out = scrubUrlsInText('redirect from http://a.example.com/p?q=1 to https://b.example.com:444/s/T/B/x failed');
    expect(out).toBe('redirect from http://a.example.com to https://b.example.com:444 failed');
  });

  it('keeps a single quote inside userinfo or path as part of the URL', () => {
    expect(scrubUrlsInText('Get "https://admin:pa\'ss@host.example.com/x?token=abc": EOF'))
      .toBe('Get "https://host.example.com": EOF');
    expect(scrubUrlsInText('Get "https://host.example.com/a\'b/SECRETPATH?token=abc": EOF'))
      .toBe('Get "https://host.example.com": EOF');
  });

  it('keeps trailing punctuation after a URL', () => {
    expect(scrubUrlsInText("posting to 'https://h.example.com/p?t=1'.")).toBe("posting to 'https://h.example.com'.");
    expect(scrubUrlsInText('(see https://h.example.com/p?t=1), then')).toBe('(see https://h.example.com), then');
  });

  it('leaves text without URLs untouched', () => {
    expect(scrubUrlsInText('expected status 200, got 503')).toBe('expected status 200, got 503');
    expect(scrubUrlsInText('')).toBe('');
  });

  it('replaces a URL it cannot reduce with a placeholder', () => {
    expect(scrubUrlsInText('failed: foo://secret-token-here/x')).not.toContain('secret-token-here');
  });
});

describe('resolveEndpointTargetInput', () => {
  const stored = 'https://ops:pw@status.example.com/hooks/T1/B1/abc123?token=xyz';
  const shown = presentEndpointTarget(stored);

  it('keeps the stored URL when the displayed origin is written back', () => {
    expect(resolveEndpointTargetInput(shown.target, { stored, field: 'target' }))
      .toEqual({ ok: true, value: stored, keptStored: true });
  });

  it('keeps the stored URL when the displayed origin comes back with its matching fingerprint', () => {
    expect(resolveEndpointTargetInput(shown.target, { stored, fingerprint: shown.fingerprint, field: 'target' }))
      .toEqual({ ok: true, value: stored, keptStored: true });
  });

  it('accepts a genuinely new full URL', () => {
    expect(resolveEndpointTargetInput('https://other.example.com/health', { stored, field: 'target' }))
      .toEqual({ ok: true, value: 'https://other.example.com/health', keptStored: false });
  });

  it('accepts a target identical to the stored one, and a bare host whose display is itself', () => {
    expect(resolveEndpointTargetInput(stored, { stored, field: 'target' })).toEqual({ ok: true, value: stored, keptStored: false });
    expect(resolveEndpointTargetInput('10.0.0.1', { stored: '10.0.0.1', field: 'target' }))
      .toEqual({ ok: true, value: '10.0.0.1', keptStored: false });
  });

  it('accepts a plain origin on create when no fingerprint is attached', () => {
    expect(resolveEndpointTargetInput('https://status.example.com', { field: 'target' }))
      .toEqual({ ok: true, value: 'https://status.example.com', keptStored: false });
  });

  it('rejects a placeholder with nothing stored to match', () => {
    for (const value of ['[invalid-url]', '[encrypted]', '[REDACTED]', '********']) {
      const r = resolveEndpointTargetInput(value, { field: 'target' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/full URL/);
    }
  });

  it('rejects a fingerprinted value on create', () => {
    const r = resolveEndpointTargetInput(shown.target, { fingerprint: shown.fingerprint, field: 'target' });
    expect(r.ok).toBe(false);
  });

  it('rejects a displayed value whose fingerprint does not match the stored URL', () => {
    const r = resolveEndpointTargetInput(shown.target, { stored, fingerprint: '000000', field: 'target' });
    expect(r.ok).toBe(false);
    const other = resolveEndpointTargetInput('https://other.example.com', { stored, fingerprint: shown.fingerprint, field: 'target' });
    expect(other.ok).toBe(false);
  });
});

describe('resolveHeaderValuesInput', () => {
  const stored = { Authorization: 'Bearer abc', 'X-Trace': 'on' };

  it('keeps stored values for headers written back as [REDACTED]', () => {
    expect(resolveHeaderValuesInput({ Authorization: '[REDACTED]', 'X-Trace': 'off' }, stored, 'headers'))
      .toEqual({ ok: true, value: { Authorization: 'Bearer abc', 'X-Trace': 'off' }, keptStored: true });
  });

  it('keeps all stored headers when the whole map comes back masked', () => {
    expect(resolveHeaderValuesInput('[REDACTED]', stored, 'headers'))
      .toEqual({ ok: true, value: stored, keptStored: true });
  });

  it('passes new header values through unchanged', () => {
    expect(resolveHeaderValuesInput({ Authorization: 'Bearer new' }, stored, 'headers'))
      .toEqual({ ok: true, value: { Authorization: 'Bearer new' }, keptStored: false });
  });

  it('rejects a masked value for a header that has no stored value', () => {
    const r = resolveHeaderValuesInput({ 'X-Api-Key': '[REDACTED]' }, stored, 'headers');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('X-Api-Key');
    expect(resolveHeaderValuesInput({ Authorization: '[REDACTED]' }, undefined, 'headers').ok).toBe(false);
    expect(resolveHeaderValuesInput('[REDACTED]', undefined, 'headers').ok).toBe(false);
  });
});

describe('findDisplayPlaceholderPath', () => {
  it('finds a masked value anywhere in a nested value', () => {
    expect(findDisplayPlaceholderPath({ a: [{ b: 'x' }, { c: '[REDACTED]' }] })).toBe('a[1].c');
    expect(findDisplayPlaceholderPath({ token: '[encrypted]' })).toBe('token');
  });

  it('returns null when nothing is masked', () => {
    expect(findDisplayPlaceholderPath({ a: [1, 'x', { b: null }] })).toBeNull();
  });
});
