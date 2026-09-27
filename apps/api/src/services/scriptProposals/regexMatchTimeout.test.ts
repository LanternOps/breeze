import { describe, expect, it } from 'vitest';
import { testRegexWithTimeout } from './regexMatchTimeout';

describe('testRegexWithTimeout', () => {
  it('resolves matched for a matching pattern', async () => {
    const r = await testRegexWithTimeout('foo', '', 'a foo b', 1000);
    expect(r).toEqual({ status: 'matched' });
  });

  it('resolves not_matched for a non-matching pattern', async () => {
    const r = await testRegexWithTimeout('nope', '', 'a foo b', 1000);
    expect(r).toEqual({ status: 'not_matched' });
  });

  it('resolves error for an invalid pattern rather than throwing', async () => {
    const r = await testRegexWithTimeout('(', '', 'a foo b', 1000);
    expect(r.status).toBe('error');
  });

  it('is a genuine wall-clock bound: a catastrophic pattern that reaches this module is killed on schedule, not left to run to completion', async () => {
    // This is exactly the shape validateRegexSafety rejects at write time
    // (nested-quantifier heuristic) — used here directly to exercise this
    // module's OWN bound in isolation, standing in for whatever a future
    // heuristic gap might let through. A plain synchronous `re.test()` of
    // this shape against 40 chars takes >2s (see clientAiDlp.test.ts); this
    // must come back in well under that, on schedule, every time.
    const start = Date.now();
    const r = await testRegexWithTimeout('(a+)+$', '', 'a'.repeat(40) + '!', 100);
    const elapsed = Date.now() - start;
    expect(r).toEqual({ status: 'timeout' });
    // Generous margin over the 100ms budget for worker-thread teardown —
    // the point is "bounded", not "exactly 100ms".
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not falsely time out a safe pattern against a large-ish haystack', async () => {
    const haystack = `${'x'.repeat(60_000)}MARKER${'y'.repeat(4_000)}`;
    const r = await testRegexWithTimeout('MARKER', '', haystack, 1000);
    expect(r).toEqual({ status: 'matched' });
  });
});
