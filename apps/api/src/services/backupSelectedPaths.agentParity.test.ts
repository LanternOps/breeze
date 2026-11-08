/**
 * #11026 W02 T4: a folder is sent to the agent as one stored-form prefix, so what
 * gets restored is decided by the agent's matcher, not by the server's list. These
 * tests hold the two to the same answer:
 *
 *  - pathSelectionMatches mirrors agent/internal/backup/restore.go, and that
 *    source is read here so a change on either side fails;
 *  - the fixtures of restore_test.go's TestFilterFiles_SiblingCollisionAndSeparators
 *    (read-only: also checked to still be there) give the same sets here;
 *  - over generated snapshots full of separator traps, every resolution selects,
 *    under the agent's rule, exactly the files the expansion it replaces listed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSelectionResolver,
  normalizeSnapshotPath,
  pathSelectionMatches,
  type SelectedSnapshotPathsResolution,
} from './backupSelectedPaths';

const AGENT_DIR = path.resolve(__dirname, '../../../../agent/internal/backup');

function resolve(selected: readonly string[], stored: readonly string[]): SelectedSnapshotPathsResolution {
  const resolver = createSelectionResolver(selected);
  for (const p of stored) resolver.add(p);
  return resolver.finish();
}

/**
 * What the agent restores for a selection: restoreSelected in restore.go, applied
 * to each manifest entry as it is decoded (#11234; filterFiles is the same rule
 * over a decoded list).
 */
const agentSelects = (stored: readonly string[], selected: readonly string[]) =>
  new Set(stored.filter((f) => selected.some((s) => pathSelectionMatches(f, s))));

/** The body of the Go function `signature` opens, through its closing brace. */
function goFunc(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found in restore.go`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start);
  return body.slice(0, body.indexOf('\n}\n') + 2);
}

describe('pathSelectionMatches mirrors the agent', () => {
  it('restore.go still implements the rule this mirrors', () => {
    const source = readFileSync(path.join(AGENT_DIR, 'restore.go'), 'utf8');
    const fn = goFunc(source, 'func pathSelectionMatches(');
    expect(fn).toContain('trimmed := strings.TrimRight(selected, `/\\`)');
    expect(fn).toContain('if sourcePath == trimmed {');
    expect(fn).toContain('return strings.HasPrefix(sourcePath, trimmed+"/") || strings.HasPrefix(sourcePath, trimmed+`\\`)');
    // And it is what a restore matches restoreSourcePath (the indexed path) with:
    // restoreSelected, against every selected path ...
    const selectedFn = goFunc(source, 'func restoreSelected(');
    expect(selectedFn).toContain('sourcePath := restoreSourcePath(*f)');
    expect(selectedFn).toContain('for _, selected := range selectedPaths {');
    expect(selectedFn).toContain('if pathSelectionMatches(sourcePath, selected) {');
    // ... applied to the manifest's entries as the restore decodes it (#11234).
    expect(goFunc(source, 'func restoreSelection(')).toContain(
      'return func(f *SnapshotFile) bool { return restoreSelected(f, selectedPaths) }',
    );
    expect(goFunc(source, 'func downloadVerifiedManifest(')).toContain(
      'decodeSnapshotManifestFile(tmpPath, restoreSelection(selectedPaths))',
    );
    expect(goFunc(source, 'func RestoreFromSnapshotContext(')).toContain(
      'downloadVerifiedManifest(ctx, provider, cfg.SnapshotID, workRoot, cfg.Integrity, cfg.SelectedPaths)',
    );
  });

  it.each([
    ['/x/prefix/pick.txt', '/x/prefix/pick.txt', true],
    ['/x/prefix/pick.txt.bak', '/x/prefix/pick.txt', false],
    ['/x/prefix/pick.txtx/inner.txt', '/x/prefix/pick.txt', false],
    ['/x/prefix/pick.txtx/inner.txt', '/x/prefix', true],
    ['C:\\x\\prefix\\pick.txt', 'C:\\x\\prefix', true],
    ['C:\\x\\prefix\\pick.txt', 'C:/x/prefix', false],
    ['C:/x/prefix\\pick.txt', 'C:/x/prefix', true],
    ['/a/b', '/a/b/', true],
    ['/a/b/c', '/a/b\\', true],
    ['/a/bc', '/a/b', false],
  ])('%s under %s → %s', (source, selected, expected) => {
    expect(pathSelectionMatches(source, selected)).toBe(expected);
  });
});

describe("restore_test.go's sibling and separator fixtures", () => {
  // Copied from TestFilterFiles_SiblingCollisionAndSeparators; the first test
  // below fails if they change there.
  const posix = ['/x/prefix/pick.txt', '/x/prefix/pick.txt.bak', '/x/prefix/pick.txt2', '/x/prefix/pick.txtx/inner.txt'];
  const windows = ['C:\\x\\prefix\\pick.txt', 'C:\\x\\prefix\\pick.txt.bak'];

  it('are still the fixtures restore_test.go uses', () => {
    const source = readFileSync(path.join(AGENT_DIR, 'restore_test.go'), 'utf8');
    const start = source.indexOf('func TestFilterFiles_SiblingCollisionAndSeparators(');
    const test = source.slice(start, source.indexOf('\n}\n', start));
    for (const p of posix) expect(test).toContain(`{SourcePath: "${p}"}`);
    for (const p of windows) expect(test).toContain(`{SourcePath: \`${p}\`}`);
  });

  it('a single file selects only itself, never its siblings', () => {
    const result = resolve(['/x/prefix/pick.txt'], posix);
    expect(result).toEqual({ ok: true, paths: ['/x/prefix/pick.txt'] });
    if (result.ok) expect(agentSelects(posix, result.paths)).toEqual(new Set(['/x/prefix/pick.txt']));
  });

  it('the parent directory selects all four', () => {
    const result = resolve(['/x/prefix'], posix);
    expect(result).toEqual({ ok: true, paths: ['/x/prefix'] });
    if (result.ok) expect(agentSelects(posix, result.paths)).toEqual(new Set(posix));
  });

  it('Windows: a single file excludes its sibling, from either spelling', () => {
    for (const selected of ['C:\\x\\prefix\\pick.txt', 'C:/x/prefix/pick.txt']) {
      const result = resolve([selected], windows);
      expect(result).toEqual({ ok: true, paths: ['C:\\x\\prefix\\pick.txt'] });
    }
  });

  it('Windows: the directory, as the browse tree sends it, selects both in their stored form', () => {
    const result = resolve(['/C:/x/prefix'], windows);
    expect(result).toEqual({ ok: true, paths: ['C:\\x\\prefix'] });
    if (result.ok) expect(agentSelects(windows, result.paths)).toEqual(new Set(windows));
  });
});

// The expansion this wave replaces (#9628, backupSelectedPaths.ts before
// #11026), kept verbatim apart from the cap as the oracle: what it listed is what
// a person selecting these paths has always restored.
function referenceExpansion(selectedPaths: readonly string[], storedPaths: readonly string[]) {
  const segmentKey = (value: string) => normalizeSnapshotPath(value).split('/').filter(Boolean).join('/');
  const exact = new Set<string>();
  const byNormalized = new Map<string, string[]>();
  for (const stored of storedPaths) {
    if (exact.has(stored)) continue;
    exact.add(stored);
    const key = normalizeSnapshotPath(stored);
    const originals = byNormalized.get(key);
    if (originals) originals.push(stored);
    else byNormalized.set(key, [stored]);
  }
  const resolved = new Set<string>();
  const segments = Array.from(byNormalized, ([key, originals]) => ({ seg: segmentKey(key), originals }));
  const dirKeys = new Set<string>();
  for (const { seg } of segments) {
    for (let i = seg.indexOf('/'); i !== -1; i = seg.indexOf('/', i + 1)) dirKeys.add(seg.slice(0, i));
  }
  const expandDirectory = (selected: string): boolean => {
    const dir = segmentKey(selected);
    if (dir === '') return false;
    let matched = false;
    for (const { seg, originals } of segments) {
      if (!seg.startsWith(`${dir}/`)) continue;
      matched = true;
      for (const original of originals) resolved.add(original);
    }
    return matched;
  };
  for (const selected of new Set(selectedPaths)) {
    let fileMatch: string | undefined;
    if (exact.has(selected)) fileMatch = selected;
    else {
      const candidates = byNormalized.get(normalizeSnapshotPath(selected));
      if (candidates) {
        if (candidates.length > 1) return { ok: false as const, invalidPath: selected, reason: 'ambiguous' as const };
        fileMatch = candidates[0]!;
      }
    }
    if (fileMatch !== undefined) {
      resolved.add(fileMatch);
      if (dirKeys.has(segmentKey(selected))) expandDirectory(selected);
    } else if (!expandDirectory(selected)) {
      return { ok: false as const, invalidPath: selected, reason: 'not_found' as const };
    }
  }
  return { ok: true as const, paths: resolved };
}

/** Deterministic, so a failure reproduces. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function generateSnapshot(random: () => number): string[] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const names = ['a', 'b', 'pick.txt', 'pick.txtx', 'pick.txt.bak', 'Docs', 'docs', 'a\\b', 'x y', 'zoë', '日本'];
  const roots = ['/', '\\', 'C:\\', 'C:/', '\\\\srv\\share\\', '//srv/share/', ''];
  const separators = ['/', '\\', '//'];
  const out = new Set<string>();
  const count = 5 + Math.floor(random() * 40);
  for (let i = 0; i < count; i += 1) {
    const depth = 1 + Math.floor(random() * 4);
    // One separator style for most paths, so plenty of folders are not mixed.
    const sep = random() < 0.8 ? pick(['/', '\\']) : null;
    let p = pick(roots);
    for (let d = 0; d < depth; d += 1) {
      if (d > 0) p += sep ?? pick(separators);
      p += pick(names);
    }
    out.add(p);
  }
  return [...out].sort();
}

function generateSelections(random: () => number, stored: readonly string[]): string[] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const segments = (p: string) => normalizeSnapshotPath(p).split('/').filter(Boolean);
  const count = 1 + Math.floor(random() * 3);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const source = pick(stored);
    const segs = segments(source);
    const cut = 1 + Math.floor(random() * segs.length);
    switch (Math.floor(random() * 5)) {
      case 0: out.push(source); break; // the stored file verbatim
      case 1: out.push(normalizeSnapshotPath(source)); break; // as the browse tree shows a file
      case 2: out.push(`/${segs.slice(0, cut).join('/')}`); break; // a folder, as the browse tree sends it
      case 3: out.push(`${segs.slice(0, cut).join('\\')}\\`); break; // a folder, backslashed, trailing separator
      default: out.push(`/${segs.slice(0, cut).join('/')}x`); // a near miss
    }
  }
  return out;
}

describe('every resolution selects exactly what the expansion it replaces listed', () => {
  it('over 3,000 generated snapshots with separator, sibling and look-alike traps', () => {
    let compared = 0;
    let prefixes = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const random = prng(seed);
      const stored = generateSnapshot(random);
      const selected = generateSelections(random, stored);
      const reference = referenceExpansion(selected, stored);
      const result = resolve(selected, stored);
      const context = `seed ${seed}: selected ${JSON.stringify(selected)} over ${JSON.stringify(stored)}`;

      if (!reference.ok) {
        expect(result, context).toEqual(reference);
        continue;
      }
      expect(result.ok, context).toBe(true);
      if (!result.ok) continue;
      expect(agentSelects(stored, result.paths), context).toEqual(reference.paths);
      compared += 1;
      prefixes += result.paths.filter((p) => !stored.includes(p)).length;
    }
    // The generator has to exercise both paths, or the comparison proves little.
    expect(compared).toBeGreaterThan(1000);
    expect(prefixes).toBeGreaterThan(300);
  });
});
