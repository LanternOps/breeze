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
  /**
   * `rawCount` defaults to the kept-item count; pass it explicitly to model a
   * page whose records were all filtered out (already-linked) upstream.
   */
  const page = <T,>(items: T[], next: string | null, rawCount = items.length) => ({
    items,
    rawCount,
    next
  });

  it('walks every page until the provider stops offering one', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 'p2'))
      .mockResolvedValueOnce(page([3, 4], 'p3'))
      .mockResolvedValueOnce(page([5], null));

    const result = await collectPaginated<number>(100, fetchPage);

    expect(result).toMatchObject({ items: [1, 2, 3, 4, 5], truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(1, null);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'p2');
    expect(fetchPage).toHaveBeenNthCalledWith(3, 'p3');
  });

  it('stops once it overshoots the cap and reports truncated', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2, 3], 'p2'))
      .mockResolvedValueOnce(page([4, 5, 6], 'p3'));

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toMatchObject({ items: [1, 2, 3, 4], truncated: true });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('is NOT truncated when the last page lands exactly on the cap', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 'p2'))
      .mockResolvedValueOnce(page([3, 4], null));

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toMatchObject({ items: [1, 2, 3, 4], truncated: false });
  });

  it('reads ONE page past an exact-multiple cap rather than crying truncation', async () => {
    // The page/offset providers infer "another page exists" from a full page,
    // so a partner holding exactly `limit` companies would otherwise be told
    // rows were dropped when none were. The extra page disambiguates.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 'p2'))
      .mockResolvedValueOnce(page([3, 4], 'p3')) // full page ⇒ inferred next
      .mockResolvedValueOnce(page([], null));

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toMatchObject({ items: [1, 2, 3, 4], truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('IS truncated when the page past the cap actually yields more', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 'p2'))
      .mockResolvedValueOnce(page([3, 4], 'p3'))
      .mockResolvedValueOnce(page([5, 6], 'p4'));

    const result = await collectPaginated<number>(4, fetchPage);

    expect(result).toMatchObject({ items: [1, 2, 3, 4], truncated: true });
  });

  it('reports WHY it stopped, so the UI can word the warning correctly', async () => {
    const capped = await collectPaginated<number>(
      2,
      vi.fn().mockResolvedValue(page([1, 2, 3], 'more'))
    );
    expect(capped).toMatchObject({ truncated: true, truncationReason: 'cap' });

    const guarded = await collectPaginated<number>(
      10_000,
      vi.fn().mockResolvedValue(page([1], 'forever'))
    );
    expect(guarded).toMatchObject({ truncated: true, truncationReason: 'page-guard' });
  });

  it('does NOT stop on a page whose records were all filtered out', async () => {
    // A full upstream page that is entirely already-linked arrives as
    // items:[] with rawCount:100. Terminating there would hide every company
    // behind it — the bug that made a PSA larger than the cap unimportable.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([], 'p2', 100))
      .mockResolvedValueOnce(page([7, 8], 'p3', 100))
      .mockResolvedValueOnce(page([], null, 0));

    const result = await collectPaginated<number>(1000, fetchPage);

    expect(result.items).toEqual([7, 8]);
    expect(result.truncated).toBe(false);
    // 100 + 98 upstream records were filtered out as already-linked.
    expect(result.filtered).toBe(198);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops on the wall-clock budget and reports truncated', async () => {
    // A slow tenant-controlled host must not be able to keep one preview
    // dialing for MAX_PSA_PAGES × the per-request timeout.
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValue(60_001);

    const fetchPage = vi.fn().mockResolvedValue(page([1], 'more'));

    const result = await collectPaginated<number>(1000, fetchPage);

    expect(result.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('terminates on an empty page even if a cursor keeps being offered', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1], 'p2'))
      .mockResolvedValue(page([], 'forever'));

    const result = await collectPaginated<number>(100, fetchPage);

    expect(result).toMatchObject({ items: [1], truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('bounds a never-ending cursor at MAX_PSA_PAGES and reports truncated', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([1], 'forever'));

    const result = await collectPaginated<number>(10_000, fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(MAX_PSA_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(MAX_PSA_PAGES);
  });

  it('propagates a cursor refusal instead of silently ending the walk', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1], 'p2'))
      .mockRejectedValueOnce(new PsaCursorOriginError('Zendesk', 'https://attacker.example', 'https://acme.example'));

    await expect(collectPaginated<number>(100, fetchPage)).rejects.toBeInstanceOf(
      PsaCursorOriginError
    );
  });
});
