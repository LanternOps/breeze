import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { isJsonContentType } from './validation';

/**
 * `isJsonContentType` COPIES Hono's private `jsonRegex`, because Hono does not
 * export it, and mounting its validator on this route would reimpose the very
 * ordering the route avoids: zValidator answers its own 400 before any handler
 * code runs. The route parses FIRST and then authorises before returning any
 * body verdict, which is what needs the predicate available standalone.
 *
 * A copy drifts silently — hono is caret-ranged, so an upgrade can change the
 * predicate with nothing here failing. Asserting hard-coded expectations would
 * NOT catch that: it would keep asserting the old truth table and stay green
 * while production diverged.
 *
 * So this uses Hono ITSELF as the oracle: the same header goes through a real
 * `validator('json', ...)` route and through the helper, and the two verdicts
 * must agree.
 *
 * HONEST LIMIT: this is a SAMPLED sentinel, not a proof of equivalence. It
 * compares the two predicates over the values listed below, so a Hono change
 * that only affects an unlisted media type or parameter syntax leaves every
 * case green while production diverges. It catches the realistic drift — the
 * structured-suffix and bogus-suffix rules, which is where a hand-rolled
 * approximation actually differs — and it is not a substitute for re-reading
 * Hono's `jsonRegex` on a major upgrade. Add a case when you meet a new one.
 *
 * The oracle asks "did Hono PARSE the body", not "did it return 400". On a
 * non-JSON media type Hono's json branch simply `break`s and hands the
 * validation function an EMPTY object — it does not reject on the media type
 * itself; a 400 only appears when the SCHEMA rejects `{}`. An identity
 * validator therefore answers 200 for `text/plain`, which measures the schema
 * rather than the media-type rule. Echoing a field from the body distinguishes
 * "parsed" from "skipped" exactly.
 */
const oracle = (() => {
  const app = new Hono();
  app.post(
    '/',
    validator('json', (value) => value as Record<string, unknown>),
    (c) => c.json({
      parsed: (c.req.valid('json') as { a?: number }).a === 1,
      // The header value AS HONO SAW IT. Header plumbing normalises HTTP
      // whitespace before either predicate runs, so comparing the helper
      // against the RAW string would flag a difference that cannot occur —
      // the helper is called with `c.req.header(...)` in production, i.e.
      // with this value, not the literal the caller typed.
      seen: c.req.header('content-type') ?? '',
    })
  );
  return async (contentType: string | undefined) => {
    const res = await app.request('/', {
      method: 'POST',
      ...(contentType === undefined ? {} : { headers: { 'Content-Type': contentType } }),
      body: JSON.stringify({ a: 1 }),
    });
    return (await res.json()) as { parsed: boolean; seen: string };
  };
})();

const CASES: Array<string | undefined> = [
  'application/json',
  'application/json; charset=utf-8',
  'application/JSON',
  'application/vnd.api+json',
  'application/merge-patch+json',
  // RFC 7807, a structured suffix this repo does not use today but which
  // future error-response work might reach for.
  'application/problem+json',
  'application/json-bogus',
  'application/jsonx',
  'text/json',
  'application/xml',
  'text/plain',
  '',
  // Non-breaking space: survives @hono/node-server's HTTP-whitespace stripping,
  // and is exactly what a `.trim()` in the helper used to swallow.
  'application/json ',
  ' application/json',
];

describe('isJsonContentType matches Hono', () => {
  it.each(CASES)('agrees with hono/validator for %j', async (ct) => {
    const { parsed, seen } = await oracle(ct);
    expect(isJsonContentType(seen)).toBe(parsed);
  });
});
