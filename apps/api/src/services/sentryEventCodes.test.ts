import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SENTRY_EVENT_CODES,
  isRegisteredSentryEventCode,
} from './sentryEventCodes';

/**
 * BREEZE-18 contract suite.
 *
 * `tsc` already rejects a `captureMessage` call with no `eventCode`, or with a
 * code outside the registry — that is the primary guard and it is why the
 * option is typed as a string-literal union rather than `string`. This suite
 * covers the two things the type system cannot see:
 *
 *   1. INTERPOLATION. `eventCode: \`db_${kind}\`` is a template literal whose
 *      type can still narrow to a union member, so tsc would accept it while a
 *      variant of it explodes the tag's cardinality in production. Only a
 *      source scan catches "must be a hardcoded literal".
 *   2. UNTYPED REACH. `ee/` extensions and any `any`-typed indirection can call
 *      captureMessage without tsc ever checking the argument.
 *
 * Precedent for scanning source in a unit test: `composeBindMounts.test.ts`
 * (apps/api) and `no-silent-mutations.test.ts` (apps/web). Following the
 * former: pure filesystem reads, no DB, so it runs in the required Test API
 * job rather than the integration shards, where a regression could hide behind
 * a stale base (see CLAUDE.md).
 */

const API_SRC = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(API_SRC, '../../..');
const EE_ROOT = join(REPO_ROOT, 'ee');
const SENTRY_MODULE = join(API_SRC, 'services/sentry.ts');

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank out `//` and block comments, preserving length and newlines so every
 * offset and line number computed later still lines up with the real source.
 *
 * Required, not cosmetic: `callArguments` treats `'` as a string delimiter, so
 * an apostrophe inside a comment desynchronises it. That is live in this repo —
 * `db/dbPoolHealthMonitor.ts` has `// States this event's own sampling rate`
 * inside a captureMessage options block, which made the parser run past the
 * call and return null for it.
 */
function blankComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  '; i += 2;
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/** Slice the argument list of the call whose `(` follows `openIndex`. */
function callArguments(source: string, openIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

interface CallSite {
  file: string;
  line: number;
  /** null when the argument list could not be parsed — an offender, never a skip. */
  args: string | null;
}

function findCaptureMessageCalls(): CallSite[] {
  const files = [...walk(API_SRC), ...walk(EE_ROOT)].filter(
    (file) => file !== SENTRY_MODULE,
  );
  const sites: CallSite[] = [];
  for (const file of files) {
    const source = blankComments(readFileSync(file, 'utf8'));
    // Only files that actually import OUR captureMessage. apps/web and
    // apps/mobile call the Sentry SDK's own captureMessage, which has a
    // different contract; neither is under the roots scanned here, but the
    // guard keeps that true if a future module re-exports the SDK.
    if (!/from\s+['"][^'"]*\/sentry['"]/.test(source)) continue;
    const pattern = /(?<![.\w])captureMessage\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const openIndex = source.indexOf('(', match.index);
      const args = callArguments(source, openIndex);
      sites.push({
        file: relative(REPO_ROOT, file),
        line: source.slice(0, match.index).split('\n').length,
        args,
      });
    }
  }
  return sites;
}

describe('SENTRY_EVENT_CODES registry', () => {
  it('holds unique, bounded, low-cardinality codes', () => {
    expect(new Set(SENTRY_EVENT_CODES).size).toBe(SENTRY_EVENT_CODES.length);
    for (const code of SENTRY_EVENT_CODES) {
      // Same ceiling `isBoundedTagValue` applies in the scrubber, and the same
      // characters `UNSAFE_TAG_CHARACTERS` rejects — a code that fails either
      // would be silently dropped from the event, restoring the blank.
      expect(code.length).toBeLessThanOrEqual(128);
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('recognises registered codes and rejects everything else at runtime', () => {
    expect(isRegisteredSentryEventCode(SENTRY_EVENT_CODES[0])).toBe(true);
    expect(isRegisteredSentryEventCode('not_a_real_code')).toBe(false);
    expect(isRegisteredSentryEventCode(undefined)).toBe(false);
    expect(isRegisteredSentryEventCode(42)).toBe(false);
  });
});

describe('captureMessage call sites (BREEZE-18)', () => {
  const sites = findCaptureMessageCalls();

  it('finds the call sites at all — a scanner matching nothing proves nothing', () => {
    // Guards against the silent-pass failure mode: a refactor that renames the
    // helper or moves the tree would otherwise turn this whole suite green by
    // scanning zero files. The floor is deliberately well under the current
    // count so ordinary churn does not touch it.
    // Tightened after the comment-stripping fix: the apostrophe desync meant
    // this scanner silently discarded one of 28 real call sites, and a floor of
    // 20 could never have noticed. Kept a little under the true count so
    // ordinary churn does not touch it, but close enough to catch a collapse.
    expect(sites.length).toBeGreaterThanOrEqual(26);
  });

  it('passes a hardcoded, registered eventCode at every call site', () => {
    const offenders: string[] = [];
    for (const site of sites) {
      const where = `${site.file}:${site.line}`;
      // A call whose arguments we could not parse is an OFFENDER, not a skip.
      // Skipping it silently is how a scanner passes while covering less than
      // it claims — and a desynced parser can also over-run into the NEXT
      // call's arguments, letting one site's code vouch for another's.
      if (site.args === null) {
        offenders.push(`${where} — could not parse the argument list; the scanner cannot vouch for this call site`);
        continue;
      }
      const match = /(?:^|[\s,{])eventCode\s*:\s*(.+)/s.exec(site.args);
      if (!match) {
        offenders.push(`${where} — no eventCode (event ships contentless)`);
        continue;
      }
      const literal = /^'([^'\\]*)'|^"([^"\\]*)"/.exec(match[1]!.trim());
      if (!literal) {
        offenders.push(
          `${where} — eventCode is not a plain string literal; it must never be `
          + `interpolated, computed or read from a variable`,
        );
        continue;
      }
      const code = literal[1] ?? literal[2]!;
      if (!isRegisteredSentryEventCode(code)) {
        offenders.push(`${where} — '${code}' is not in SENTRY_EVENT_CODES`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
