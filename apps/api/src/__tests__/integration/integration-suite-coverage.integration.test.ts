import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import integrationConfig from '../../../vitest.integration.config';

// NOTE: importing the real config module runs its module-scope
// `config({ path: '../../.env.test' })` (dotenv) call as a side effect.
// That's a deliberate trade-off, not an oversight: reading the config's
// actual `include`/`exclude` arrays (rather than hand-copying them, which
// would drift) requires importing the module, and dotenv silently no-ops
// when the target file is absent or already loaded. If a future change adds
// something less inert at module scope in vitest.integration.config.ts
// (e.g. eager env validation), this "static-analysis only, no DB/Redis"
// runner would need to be revisited.

/**
 * Contract test for #4522: every `*.integration.test.ts` file under `src/`
 * must be reachable by SOME CI job, or explicitly and visibly documented as
 * intentionally excluded.
 *
 * `invoiceService.issue.integration.test.ts` and `invoicePdf.integration.test.ts`
 * were briefly reported as unmatched by `vitest.integration.config.ts`'s
 * include list (they were in fact added in the same PR that created them —
 * see the "Wave 6 (#3778)" comment in that config), but nothing previously
 * asserted the include/exclude lists stay in sync with the files that
 * actually exist on disk. A file can silently fall out of coverage forever
 * — added under a path no include pattern matches, or excluded and then
 * never given a home elsewhere — and CI would stay green throughout,
 * because a test that never runs can never fail.
 *
 * This test reads `vitest.integration.config.ts`'s own `test.include` /
 * `test.exclude` arrays (not a hand-copied duplicate, so it can't drift from
 * the real config) and checks every `*.integration.test.ts` file on disk is
 * matched by (include - exclude), OR appears in the
 * `KNOWN_OUTSIDE_INTEGRATION_SUITE` allowlist below with a comment
 * justifying why it intentionally runs elsewhere (or nowhere yet, tracked
 * separately). A new orphan must either get an include entry or a
 * justified allowlist entry — the default action is to wire it in, not
 * extend the allowlist.
 */

// Files that are `*.integration.test.ts` by name but are intentionally NOT
// covered by `vitest.integration.config.ts`'s include list. Each entry must
// be justified. Keep this in sync with the `exclude` comments in
// `vitest.integration.config.ts` and `vitest.config.ts` — this allowlist is
// what proves each excluded file still runs *somewhere*, not just that it
// was excluded from here.
const KNOWN_OUTSIDE_INTEGRATION_SUITE: ReadonlySet<string> = new Set<string>([
  // Uses fresh request-pool modules and manages its own temporary role;
  // has its own dedicated runner (vitest.config.request-db-role.ts,
  // `pnpm test:request-db-role`).
  'src/db/requestDatabaseRole.integration.test.ts',
  // Mocked unit test that stubs the postgres/drizzle layer at the module
  // level despite its `.integration.test.ts` name; has its own dedicated
  // runner (vitest.config.rls.ts, `pnpm test:rls`).
  'src/__tests__/integration/rls.integration.test.ts',
  // Read-only pg_catalog inspection; has its own dedicated runner
  // (vitest.config.rls-coverage.ts, `pnpm test:rls-coverage`).
  'src/__tests__/integration/rls-coverage.integration.test.ts',
  // Pure static-analysis scan of `src/routes/**/*.ts`; has its own
  // dedicated runner (vitest.config.site-scope-coverage.ts,
  // `pnpm test:site-scope-coverage`).
  'src/__tests__/integration/site-scope-coverage.integration.test.ts',
  // This contract test itself; has its own dedicated runner
  // (vitest.config.integration-suite-coverage.ts,
  // `pnpm test:integration-suite-coverage`).
  'src/__tests__/integration/integration-suite-coverage.integration.test.ts',
  // Has multiple pre-existing broken tests that only surfaced once
  // setup.ts started applying schema via autoMigrate; deliberately
  // excluded from the integration config pending a dedicated audit
  // against current auth route shapes (tracked as a follow-up issue, not
  // #4522). Genuinely NOT run in any CI job today — a known, documented
  // gap, not a new orphan this test is meant to catch.
  'src/__tests__/integration/auth.integration.test.ts',
  // Mocked unit test despite its `.integration.test.ts` name (mocks
  // `../db`); intentionally runs under the default unit runner
  // (vitest.config.ts) instead, per that config's own exclude comment.
  'src/services/manifestSigning.integration.test.ts',
]);

const API_ROOT = path.resolve(__dirname, '../../..');

async function findIntegrationTestFiles(root: string): Promise<string[]> {
  const srcDir = path.join(root, 'src');
  const entries = await fs.readdir(srcDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.integration.test.ts')) continue;
    // Node's recursive readdir reports `parentPath` as the absolute
    // directory containing the entry.
    const absPath = path.join(entry.parentPath, entry.name);
    files.push(path.relative(root, absPath).split(path.sep).join('/'));
  }
  return files.sort();
}

// Minimal glob matcher covering the two pattern shapes actually used by
// vitest.integration.config.ts's include list: literal paths, and
// `dir/**/*.ext`-style globs (`**` matches any depth including zero
// directories, `*` matches within one path segment). Not a general-purpose
// glob implementation — if a future include entry needs a shape this
// doesn't support, extend this function rather than working around it.
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === undefined) continue;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function isCoveredByIntegrationConfig(relPath: string): boolean {
  const { include, exclude } = integrationConfig.test as { include: string[]; exclude: string[] };
  const excluded = exclude.some((pattern) => globToRegExp(pattern).test(relPath));
  if (excluded) return false;
  return include.some((pattern) => globToRegExp(pattern).test(relPath));
}

describe('globToRegExp (matcher used by the coverage checks below)', () => {
  it('matches literal paths exactly, and nothing else', () => {
    const re = globToRegExp('src/services/invoicePdf.integration.test.ts');
    expect(re.test('src/services/invoicePdf.integration.test.ts')).toBe(true);
    expect(re.test('src/services/invoicePdf.integration.test.ts.bak')).toBe(false);
    expect(re.test('other/src/services/invoicePdf.integration.test.ts')).toBe(false);
  });

  it('matches `dir/**/*.ext`-style globs at any depth, including zero', () => {
    const re = globToRegExp('src/__tests__/integration/**/*.test.ts');
    expect(re.test('src/__tests__/integration/rls.integration.test.ts')).toBe(true);
    expect(re.test('src/__tests__/integration/nested/dir/foo.test.ts')).toBe(true);
    expect(re.test('src/__tests__/integration/foo.ts')).toBe(false);
    expect(re.test('src/other/foo.test.ts')).toBe(false);
  });
});

describe('integration test suite coverage (#4522)', () => {
  it('every *.integration.test.ts file is either in the integration config include list or a justified allowlist entry', async () => {
    const files = await findIntegrationTestFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const orphans = files.filter(
      (f) => !isCoveredByIntegrationConfig(f) && !KNOWN_OUTSIDE_INTEGRATION_SUITE.has(f)
    );

    expect(
      orphans,
      `Found *.integration.test.ts file(s) matched by NO include pattern in ` +
        `vitest.integration.config.ts and NOT in this test's ` +
        `KNOWN_OUTSIDE_INTEGRATION_SUITE allowlist — they run in no CI job:\n` +
        orphans.map((f) => `  - ${f}`).join('\n')
    ).toEqual([]);
  });

  it('every KNOWN_OUTSIDE_INTEGRATION_SUITE entry still exists on disk', async () => {
    const files = new Set(await findIntegrationTestFiles(API_ROOT));
    const stale = [...KNOWN_OUTSIDE_INTEGRATION_SUITE].filter((f) => !files.has(f));
    expect(
      stale,
      `KNOWN_OUTSIDE_INTEGRATION_SUITE names file(s) that no longer exist — ` +
        `remove the stale entry:\n` + stale.map((f) => `  - ${f}`).join('\n')
    ).toEqual([]);
  });

  it('every literal (non-glob) include entry in the integration config still resolves to a file on disk', async () => {
    // The disk->config checks above only catch a file that exists but isn't
    // wired in. They miss the inverse: an include entry left behind after
    // its file was deleted or renamed, which just quietly does nothing
    // forever (config drift, not a CI gap) — e.g. a since-deleted
    // `twoReplicaReconcile.integration.test.ts` sat in this exact include
    // list for a release after its source file was removed (#3488). Only
    // literal (non-glob) entries are checked: a glob entry that currently
    // matches zero files isn't necessarily stale — it just means no file
    // happens to live under that pattern right now.
    const files = new Set(await findIntegrationTestFiles(API_ROOT));
    const { include } = integrationConfig.test as { include: string[] };
    const staleIncludes = include.filter((pattern) => !pattern.includes('*') && !files.has(pattern));

    expect(
      staleIncludes,
      `vitest.integration.config.ts's include list names file(s) that no ` +
        `longer exist on disk — remove the stale entry:\n` +
        staleIncludes.map((f) => `  - ${f}`).join('\n')
    ).toEqual([]);
  });
});
