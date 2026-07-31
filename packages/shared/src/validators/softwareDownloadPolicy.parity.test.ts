import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isNumericLookingHost,
  normalizePrivateSoftwareOrigin,
  privateSoftwareOriginSchema,
} from './softwareDownloadPolicy';

// The TS half of the shared Go/TS accept-set parity contract (finding C1 of the
// Wave 6 whole-branch security review). The Go half is
// agent/internal/netpolicy/origin_parity_test.go and reads the SAME file.
//
// The point of a shared fixture rather than two hand-kept tables: this validator
// decides what gets PERSISTED, and the agent's netpolicy.parseOrigin decides what
// is usable. When the validator's accept-set exceeds the agent's, an operator can
// save an allowlist entry — `https://192.168.1.x`, exactly how a tech writes a
// subnet — that the agent cannot parse, and one such row degrades the approved
// set for every managed-software install in that org/site.
//
// This suite asserts the TS side of every case. The Go side asserts that every
// non-null `tsNormalized` in the fixture is parseable by parseOrigin, which is
// the actual subset property. Neither test alone is sufficient.

interface ParityCase {
  origin: string;
  goAcceptsRaw: boolean;
  tsNormalized: string | null;
  note: string;
}

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../agent/internal/netpolicy/testdata/origin_accept_parity.json',
);

const cases: ParityCase[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).cases;

describe('Go/TS approved-origin accept-set parity', () => {
  it('reads a fixture with real accept AND reject cases (guards a vacuous suite)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((c) => c.tsNormalized !== null).length).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.tsNormalized === null).length).toBeGreaterThanOrEqual(5);
  });

  it.each(cases.map((c) => [c.origin, c] as const))(
    'normalizes %s exactly as the shared fixture records',
    (_origin, tc) => {
      expect(normalizePrivateSoftwareOrigin(tc.origin), tc.note).toBe(tc.tsNormalized);
    },
  );

  it.each(cases.map((c) => [c.origin, c] as const))(
    'the Zod schema agrees with the normalizer for %s',
    (_origin, tc) => {
      // The schema is the surface a route actually uses; assert it does not
      // diverge from the exported normalizer the fixture is written against.
      const parsed = privateSoftwareOriginSchema.safeParse(tc.origin);
      if (tc.tsNormalized === null) {
        expect(parsed.success, tc.note).toBe(false);
      } else {
        expect(parsed.success, tc.note).toBe(true);
        if (parsed.success) expect(parsed.data).toBe(tc.tsNormalized);
      }
    },
  );

  it('every stored value is idempotent under re-normalization', () => {
    // The API re-validates on read with this same schema, so a stored value that
    // did not round-trip would be dropped (or mutated) on the way to the agent.
    for (const tc of cases) {
      if (tc.tsNormalized === null) continue;
      expect(normalizePrivateSoftwareOrigin(tc.tsNormalized), tc.note).toBe(tc.tsNormalized);
    }
  });
});

describe('isNumericLookingHost (mirror of Go netpolicy/address.go)', () => {
  it.each([
    ['192.168.1.x', 'partially-written subnet — the C1 case'],
    ['172.16.x.x', 'two wildcard labels'],
    ['0xdead.beef', 'hex shorthand with a 0x marker'],
    ['0x1.0x2.ba.be', 'mixed hex shorthand'],
    ['2130706433', 'decimal shorthand'],
    ['0177.0.0.1', 'octal shorthand'],
    ['127.1', 'short-form shorthand'],
    ['1.2.3.4.5', 'too many numeric labels'],
  ])('rejects %s (%s)', (host) => {
    expect(isNumericLookingHost(host)).toBe(true);
  });

  it.each([
    ['beef.cafe', 'all hex letters but no 0x marker — must NOT be read as shorthand'],
    ['x.x', 'separator/marker characters only, but no digit (hasDigit rule)'],
    ['files.corp.internal', 'ordinary name'],
    ['cdn-1.example.com', 'digit plus a hyphen'],
    ['10-0-0-5.corp.example', 'digits and hyphens'],
    ['', 'empty string has no digit'],
  ])('accepts %s (%s)', (host) => {
    expect(isNumericLookingHost(host)).toBe(false);
  });
});
