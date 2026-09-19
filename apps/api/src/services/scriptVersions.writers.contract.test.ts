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

/** Empty as of W01a Task 13 — every legacy writer now goes through
 *  cutScriptVersion. This set exists so the ratchet's shape is obvious; adding
 *  an entry means adding a second writer, which the spec forbids. */
const PENDING_CONVERSION: ReadonlySet<string> = new Set<string>([]);

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

/**
 * The mirror contract (#5622): every file that INSERTS a `scripts` row must
 * also cut that row's v1 version in the same unit of work.
 *
 * The scan above only sees writers of `script_versions`. It is blind to the
 * opposite defect — a create path that inserts into `scripts` and never cuts a
 * version, leaving a HEADLESS script whose `headScriptVersion()` is null
 * forever. `db/seed.ts` shipped exactly that (#5622): it never imports
 * `scriptVersions`, so nothing in the sole-writer scan could have noticed.
 *
 * Text scan, same style as above: no import graph is loaded, so a partial
 * db/schema mock elsewhere cannot make this vacuous.
 */
const SCRIPT_INSERTERS: ReadonlySet<string> = new Set<string>([
  'db/seed.ts',
  'routes/scripts.ts',
  'services/scriptWrite.ts',
  'services/scriptClone.ts',
  'services/systemScriptLibrary.ts',
]);

describe('every scripts insert cuts a v1 version', () => {
  const inserters = listTsFiles(API_SRC)
    .map((full) => ({ rel: relative(API_SRC, full).split(sep).join('/'), full }))
    .filter(({ rel }) => !rel.endsWith('.test.ts') && !rel.startsWith('__tests__/'))
    .filter(({ full }) => /\.insert\(\s*scripts\s*\)/.test(readFileSync(full, 'utf8')));

  it('the scan is not vacuous', () => {
    expect(inserters.map((f) => f.rel).sort()).toEqual([...SCRIPT_INSERTERS].sort());
  });

  it.each([...SCRIPT_INSERTERS])('%s cuts a version for the row it inserts', (rel) => {
    const src = readFileSync(join(API_SRC, ...rel.split('/')), 'utf8');
    expect(
      src,
      `${rel} inserts into \`scripts\` but never calls cutScriptVersion (directly or via ` +
        `insertScriptRow). A script created without a v1 row is headless: headScriptVersion() ` +
        `returns null for it forever, and script_versions is append-only so it cannot be ` +
        `repaired afterwards (#5622).`
    ).toMatch(/cutScriptVersion|insertScriptRow/);
  });
});
