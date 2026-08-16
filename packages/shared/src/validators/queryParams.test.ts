import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { optionalQueryBoolean } from './queryParams';

describe('optionalQueryBoolean', () => {
  const schema = optionalQueryBoolean;

  it('parses the string form correctly — including the z.coerce.boolean footgun cases', () => {
    // The whole point: these must NOT be truthiness-coerced to true.
    expect(schema.parse('false')).toBe(false);
    expect(schema.parse('0')).toBe(false);
    expect(schema.parse('no')).toBe(false);
    expect(schema.parse('off')).toBe(false);
    expect(schema.parse('FALSE')).toBe(false);
    expect(schema.parse(' false ')).toBe(false);

    expect(schema.parse('true')).toBe(true);
    expect(schema.parse('1')).toBe(true);
    expect(schema.parse('yes')).toBe(true);
    expect(schema.parse('on')).toBe(true);
    expect(schema.parse('TRUE')).toBe(true);
  });

  it('absent stays undefined (no filter); a bare flag stays false (preserves old coerce)', () => {
    expect(schema.parse(undefined)).toBeUndefined();
    // Boolean('') === false, so ?flag with no value kept meaning false, not "unfiltered".
    expect(schema.parse('')).toBe(false);
    expect(schema.parse('   ')).toBe(false);
  });

  it('passes real booleans through', () => {
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });

  it('rejects garbage rather than silently coercing it', () => {
    expect(schema.safeParse('maybe').success).toBe(false);
    expect(schema.safeParse('2').success).toBe(false);
    expect(schema.safeParse('truthy').success).toBe(false);
  });

  it('documents the bug it replaces: z.coerce.boolean() coerces "false" to true', () => {
    expect(z.coerce.boolean().parse('false')).toBe(true); // the footgun, for the record
    expect(optionalQueryBoolean.parse('false')).toBe(false); // the fix
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Regression guard for the whole class: no query/validator schema may use
 * z.coerce.boolean() again — it silently coerces "false"/"0" to true. Use
 * optionalQueryBoolean (this file) instead. Scans the route + shared-validator
 * trees the same way bodyLimit.test.ts scans for body-limit drift.
 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      out.push(...tsFiles(full));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// packages/shared/src/validators -> repo root is five levels up.
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

describe('no z.coerce.boolean() on external input (regression guard)', () => {
  it('every route + shared validator uses optionalQueryBoolean, never z.coerce.boolean()', () => {
    const roots = [
      join(repoRoot, 'apps', 'api', 'src', 'routes'),
      join(repoRoot, 'packages', 'shared', 'src', 'validators'),
    ].filter((d) => {
      try { return statSync(d).isDirectory(); } catch { return false; }
    });
    // Fail loudly if the scan root ever stops resolving (would pass vacuously).
    expect(roots.length).toBe(2);

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        // Exempt ONLY the canonical helper itself (its doc comment names the
        // anti-pattern on purpose). Match the exact path, not any queryParams.ts.
        if (file === join(repoRoot, 'packages', 'shared', 'src', 'validators', 'queryParams.ts')) continue;
        const src = readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          // strip a // tail and skip JSDoc/`*` comment lines so a documenting
          // mention can't false-positive; the literal call is what matters.
          const trimmed = line.trimStart();
          if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
          const code = line.replace(/\/\/.*$/, '');
          if (/z\.coerce\.boolean\s*\(/.test(code)) {
            offenders.push(`${file.slice(repoRoot.length + 1)}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders, `use optionalQueryBoolean instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
