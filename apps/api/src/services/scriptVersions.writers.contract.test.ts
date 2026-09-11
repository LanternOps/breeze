import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * services/scriptVersions.ts is the ONLY writer of `script_versions` (spec
 * §4.1, roadmap §3.2). A second insert path is how a version row lands without
 * a digest, without a provenance record, or at a number that races the head —
 * and the table is append-only, so a bad row cannot be repaired afterwards.
 *
 * Style follows aiGuardrails.imports.contract.test.ts: read the source, assert
 * on the text. No import graph is loaded, so a partial db/schema mock in some
 * other suite cannot make this vacuous.
 *
 * PENDING_CONVERSION is a RATCHET, not a permanent exemption. It lists the
 * legacy writers W01a converts one task at a time. Entries are only ever
 * REMOVED. If you are adding one, you are adding a second writer — don't.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));

const SOLE_WRITER = 'services/scriptVersions.ts';

const PENDING_CONVERSION: ReadonlySet<string> = new Set<string>([
  'services/scriptBundle/index.ts',
]);

/** Files that may legitimately reference the table without inserting into it:
 *  tests, and the schema module that defines it. */
function isExempt(rel: string): boolean {
  return (
    rel.endsWith('.test.ts') ||
    rel.startsWith('__tests__' + sep) ||
    rel === 'db/schema/scripts.ts' ||
    rel === SOLE_WRITER
  );
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('script_versions has exactly one writer', () => {
  const offenders = listTsFiles(API_SRC)
    .map((full) => ({ rel: relative(API_SRC, full).split(sep).join('/'), full }))
    .filter(({ rel }) => !isExempt(rel.split('/').join(sep)))
    .filter(({ full }) => /\.insert\(\s*scriptVersions\s*\)/.test(readFileSync(full, 'utf8')))
    .map(({ rel }) => rel);

  it('no file outside services/scriptVersions.ts inserts into scriptVersions', () => {
    const unexpected = offenders.filter((rel) => !PENDING_CONVERSION.has(rel));
    expect(
      unexpected,
      `These files insert into script_versions directly. Call cutScriptVersion(tx, { scriptId, provenance }) ` +
        `from services/scriptVersions.ts instead:\n${JSON.stringify(unexpected, null, 2)}`
    ).toEqual([]);
  });

  it('the conversion ratchet has no stale entries', () => {
    const stale = [...PENDING_CONVERSION].filter((rel) => !offenders.includes(rel));
    expect(
      stale,
      `PENDING_CONVERSION lists files that no longer insert into script_versions. ` +
        `Remove them — the list only ever shrinks:\n${JSON.stringify(stale, null, 2)}`
    ).toEqual([]);
  });

  it('services/scriptVersions.ts really does insert (guards against a vacuous scan)', () => {
    const src = readFileSync(join(API_SRC, SOLE_WRITER), 'utf8');
    expect(src).toMatch(/\.insert\(\s*scriptVersions\s*\)/);
  });
});
