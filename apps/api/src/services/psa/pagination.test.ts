import { describe, it, expect, vi } from 'vitest';
import {
  MAX_PSA_PAGES,
  PsaCursorOriginError,
  collectPaginated,
  pinCursorToBase
} from './pagination';

describe('pinCursorToBase', () => {
  const base = 'https://acme.zendesk.com';

  it('accepts a same-origin cursor and rebuilds it on the stored origin', () => {
    expect(
      pinCursorToBase('https://acme.zendesk.com/api/v2/organizations.json?page=2', base)
    ).toBe('https://acme.zendesk.com/api/v2/organizations.json?page=2');
  });

  it('accepts a cursor rooted ABOVE the stored base path', () => {
    // Autotask stores baseUrl with a sub-path but returns cursors from the root.
    expect(
      pinCursorToBase(
        'https://webservices2.autotask.net/atservicesrest/v1.0/Companies?search=x',
        'https://webservices2.autotask.net/atservicesrest'
      )
    ).toBe('https://webservices2.autotask.net/atservicesrest/v1.0/Companies?search=x');
  });

  it('accepts a relative cursor by resolving it against the base', () => {
    expect(pinCursorToBase('/api/v2/organizations.json?page=3', base)).toBe(
      'https://acme.zendesk.com/api/v2/organizations.json?page=3'
    );
  });

  // ── The security cases ────────────────────────────────────────────────────
  it('REFUSES a cursor pointing at an attacker-controlled host', () => {
    expect(() => pinCursorToBase('https://attacker.example/steal?x=1', base)).toThrow(
      PsaCursorOriginError
    );
  });

  it('REFUSES a cursor pointing at cloud metadata', () => {
    expect(() => pinCursorToBase('http://169.254.169.254/latest/meta-data/', base)).toThrow(
      PsaCursorOriginError
    );
  });

  it('REFUSES a same-host cursor on a different scheme or port', () => {
    // Origin is scheme+host+port: downgrading to http, or moving to another
    // port, is a different origin and could hit an unrelated local service.
    expect(() => pinCursorToBase('http://acme.zendesk.com/api/v2/x', base)).toThrow(
      PsaCursorOriginError
    );
    expect(() => pinCursorToBase('https://acme.zendesk.com:8443/api/v2/x', base)).toThrow(
      PsaCursorOriginError
    );
  });

  it('REFUSES a cursor smuggling credentials in userinfo', () => {
    expect(() =>
      pinCursorToBase('https://acme.zendesk.com@attacker.example/x', base)
    ).toThrow(PsaCursorOriginError);
  });

  it('keeps a garbage cursor ON-ORIGIN rather than dialing it as given', () => {
    // A cursor that is not a valid ABSOLUTE url resolves relative to the base,
    // so it can only ever produce an on-origin (harmlessly 404-ing) request.
    // The security property is origin pinning, not cursor well-formedness.
    expect(pinCursorToBase('::::not a url', base)).toBe(
      'https://acme.zendesk.com/::::not%20a%20url'
    );
  });

  it('REFUSES when the stored base URL itself is unparseable', () => {
    expect(() => pinCursorToBase('https://acme.zendesk.com/x', 'not-a-base')).toThrow(
      PsaCursorOriginError
    );
  });

  it('reports both origins on refusal, for an actionable log line', () => {
    try {
      pinCursorToBase('https://attacker.example/x', base);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PsaCursorOriginError);
      const err = error as PsaCursorOriginError;
      expect(err.cursorOrigin).toBe('https://attacker.example');
      expect(err.expectedOrigin).toBe('https://acme.zendesk.com');
    }
  });
});

describe('collectPaginated', () => {
  it('walks every page until the provider stops offering one', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], next: 'p2' })
      .mockResolvedValueOnce({ items: [3, 4], next: 'p3' })
      .mockResolvedValueOnce({ items: [5], next: null });

    const result = await collectPaginated<number>(100, fetchPage);

    expect(result).toEqual({ items: [1, 2, 3, 4, 5], truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(1, null);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'p2');
    expect(fetchPage).toHaveBeenNthCalledWith(3, 'p3');
  });

  it('stops at the cap and reports truncated when more pages remain', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2, 3], next: 'p2' })
      .mockResolvedValueOnce({ items: [4, 5, 6], next: 'p3' });

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toEqual({ items: [1, 2, 3, 4], truncated: true });
    // Stopped as soon as the cap was reached — no third request.
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('is NOT truncated when the last page lands exactly on the cap', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], next: 'p2' })
      .mockResolvedValueOnce({ items: [3, 4], next: null });

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toEqual({ items: [1, 2, 3, 4], truncated: false });
  });

  it('IS truncated when the cap is hit exactly but another page is offered', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], next: 'p2' })
      .mockResolvedValueOnce({ items: [3, 4], next: 'p3' });

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toEqual({ items: [1, 2, 3, 4], truncated: true });
  });

  it('terminates on an empty page even if a cursor keeps being offered', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], next: 'p2' })
      .mockResolvedValue({ items: [], next: 'forever' });

    const result = await collectPaginated<number>(100, fetchPage);

    expect(result).toEqual({ items: [1], truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('bounds a never-ending cursor at MAX_PSA_PAGES and reports truncated', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [1], next: 'forever' });

    const result = await collectPaginated<number>(10_000, fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(MAX_PSA_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(MAX_PSA_PAGES);
  });

  it('propagates a cursor refusal instead of silently ending the walk', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], next: 'p2' })
      .mockRejectedValueOnce(new PsaCursorOriginError('https://attacker.example', 'https://acme.example'));

    await expect(collectPaginated<number>(100, fetchPage)).rejects.toBeInstanceOf(
      PsaCursorOriginError
    );
  });
});
