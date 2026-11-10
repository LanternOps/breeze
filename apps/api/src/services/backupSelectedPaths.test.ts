import { describe, expect, it } from 'vitest';
import {
  createSelectionResolver,
  MAX_SELECTED_RESTORE_FILES,
  normalizeSnapshotPath,
  selectedSnapshotPathError,
} from './backupSelectedPaths';

/** Every stored path through the resolver, as the database walk feeds it. */
function resolve(selected: readonly string[], stored: Iterable<string>) {
  const resolver = createSelectionResolver(selected);
  for (const path of stored) resolver.add(path);
  return resolver.finish();
}

describe('normalizeSnapshotPath', () => {
  it.each([
    ['C:\\Users\\alex\\Documents\\invoice.pdf', 'C:/Users/alex/Documents/invoice.pdf'],
    ['\\\\fileserver\\share\\finance\\q3.xlsx', '//fileserver/share/finance/q3.xlsx'],
    ['C:\\Users/alex\\Documents/invoice.pdf', 'C:/Users/alex/Documents/invoice.pdf'],
    ['/home/alex/notes.txt', '/home/alex/notes.txt'],
    ['/Users/alex/Library/prefs.plist', '/Users/alex/Library/prefs.plist'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeSnapshotPath(input)).toBe(expected);
  });

  it('does not resolve dot segments (no path.normalize semantics)', () => {
    expect(normalizeSnapshotPath('C:\\Users\\..\\Windows\\x.dll')).toBe('C:/Users/../Windows/x.dll');
  });
});

describe('createSelectionResolver — files', () => {
  const windowsStored = [
    'C:\\Users\\alex\\Documents\\invoice.pdf',
    'C:\\Users\\alex\\Documents\\report.docx',
    '\\\\fileserver\\share\\finance\\q3.xlsx',
  ];

  it('maps a forward-slash Windows drive path (as shown by the browse tree) back to the stored original', () => {
    expect(
      resolve(['C:/Users/alex/Documents/invoice.pdf'], windowsStored)
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\invoice.pdf'] });
  });

  it('maps a forward-slash UNC path back to the stored original', () => {
    expect(
      resolve(['//fileserver/share/finance/q3.xlsx'], windowsStored)
    ).toEqual({ ok: true, paths: ['\\\\fileserver\\share\\finance\\q3.xlsx'] });
  });

  it('maps a mixed-separator selection back to the stored original', () => {
    expect(
      resolve(['C:\\Users/alex\\Documents/report.docx'], windowsStored)
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\report.docx'] });
  });

  it('accepts the stored original verbatim', () => {
    expect(
      resolve(['C:\\Users\\alex\\Documents\\invoice.pdf'], windowsStored)
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\invoice.pdf'] });
  });

  it('de-duplicates two spellings of the same file', () => {
    expect(
      resolve(
        ['C:/Users/alex/Documents/invoice.pdf', 'C:\\Users\\alex\\Documents\\invoice.pdf'],
        windowsStored
      )
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\invoice.pdf'] });
  });

  it('keeps Linux and macOS paths working unchanged', () => {
    const stored = ['/home/alex/notes.txt', '/Users/alex/Library/prefs.plist'];
    expect(
      resolve(['/home/alex/notes.txt', '/Users/alex/Library/prefs.plist'], stored)
    ).toEqual({ ok: true, paths: ['/home/alex/notes.txt', '/Users/alex/Library/prefs.plist'] });
  });

  it('prefers an exact match over a separator-normalized one on POSIX paths containing a backslash', () => {
    // On Linux a backslash is a legal filename character, so both files can
    // coexist and normalize to the same key. An exact selection must pick
    // exactly the file named, never its look-alike.
    const stored = ['/srv/a\\b.txt', '/srv/a/b.txt'];
    expect(resolve(['/srv/a/b.txt'], stored)).toEqual({ ok: true, paths: ['/srv/a/b.txt'] });
    expect(resolve(['/srv/a\\b.txt'], stored)).toEqual({ ok: true, paths: ['/srv/a\\b.txt'] });
  });

  it('refuses a normalized selection that maps to more than one stored file', () => {
    // Neither stored path equals the selection and both normalize to it:
    // picking one would be a guess, so the selection is refused.
    const collide = ['C:\\dir/x.txt', 'C:/dir\\x.txt'];
    expect(resolve(['C:/dir/x.txt'], collide)).toEqual({
      ok: false,
      invalidPath: 'C:/dir/x.txt',
      reason: 'ambiguous',
    });
  });

  it.each([
    ['dot-segment traversal out of a selected root', 'C:/Users/alex/Documents/../../../Windows/System32/config/SAM'],
    ['dot-segment that would re-resolve to a stored file', 'C:/Users/alex/Temp/../Documents/invoice.pdf'],
    ['a partial directory name', 'C:/Users/alex/Docum'],
    ['a directory with no files under it', 'C:/Users/alex/Empty'],
    ['a path outside the snapshot', 'D:/secrets/keys.txt'],
    ['a case-variant of a stored path', 'c:/users/alex/documents/invoice.pdf'],
    ['a trailing-separator variant', 'C:/Users/alex/Documents/invoice.pdf/'],
    ['a doubled-separator variant', 'C://Users/alex/Documents/invoice.pdf'],
    ['an empty string', ''],
  ])('refuses %s', (_label, selection) => {
    expect(resolve([selection], windowsStored)).toEqual({
      ok: false,
      invalidPath: selection,
      reason: 'not_found',
    });
  });

  it('reports the first unavailable selection and resolves nothing', () => {
    expect(
      resolve(
        ['C:/Users/alex/Documents/invoice.pdf', '/etc/shadow', 'C:/nope.txt'],
        windowsStored
      )
    ).toEqual({ ok: false, invalidPath: '/etc/shadow', reason: 'not_found' });
  });

  it('never returns a path that is not one of the stored originals', () => {
    const selections = [
      'C:/Users/alex/Documents/invoice.pdf',
      '//fileserver/share/finance/q3.xlsx',
      'C:\\Users/alex\\Documents/report.docx',
    ];
    const result = resolve(selections, windowsStored);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const path of result.paths) expect(windowsStored).toContain(path);
    }
  });
});

describe('resolve — directory selection (#9628, #11026 D9)', () => {
  const stored = [
    'C:\\Users\\alex\\Documents\\invoice.pdf',
    'C:\\Users\\alex\\Documents\\sub\\deep.txt',
    'C:\\Users\\alex\\Documents2\\other.txt',
    'C:\\Users\\alex\\Documentsx',
  ];
  // A directory resolves to its stored-form prefix: the agent selects every
  // entry beneath it (restore.go pathSelectionMatches).
  const docsExpected = { ok: true, paths: ['C:\\Users\\alex\\Documents'] };

  it('resolves a directory to its stored-form prefix (nested files included)', () => {
    expect(resolve(['C:/Users/alex/Documents'], stored)).toEqual(docsExpected);
  });

  it('accepts the directory with a backslash spelling or trailing separator', () => {
    expect(resolve(['C:\\Users\\alex\\Documents'], stored)).toEqual(docsExpected);
    expect(resolve(['C:/Users/alex/Documents/'], stored)).toEqual(docsExpected);
  });

  it('does not match sibling directories or files sharing a name prefix', () => {
    expect(resolve(['C:/Users/alex/Documents'], stored)).toEqual(docsExpected);
  });

  it.each([
    ['a trailing dot-segment', 'C:/Users/alex/Documents/..'],
    ['a dot-segment inside the directory', 'C:/Users/alex/Temp/../Documents'],
    ['a case-variant directory', 'c:/users/alex/documents'],
  ])('refuses %s as a directory selection', (_label, selection) => {
    expect(resolve([selection], stored)).toEqual({
      ok: false,
      invalidPath: selection,
      reason: 'not_found',
    });
  });

  it('a folder that shares its name with a file (b and b/…) selects both, never dropping the contents', () => {
    // One string: the agent matches `/a/b` itself and everything under `/a/b/`.
    expect(resolve(['/a/b'], ['/a/b', '/a/b/c.txt', '/a/bb/d.txt'])).toEqual({ ok: true, paths: ['/a/b'] });
    // Spelled differently, the file and the folder are two strings.
    expect(resolve(['/a/b'], ['\\a\\b', '/a/b/c.txt'])).toEqual({ ok: true, paths: ['\\a\\b', '/a/b'] });
  });

  it('several large folders fit, because each is one prefix', () => {
    const half = MAX_SELECTED_RESTORE_FILES / 2 + 1;
    const paths = [
      ...Array.from({ length: half }, (_, i) => `/x/f${i}`),
      ...Array.from({ length: half }, (_, i) => `/y/f${i}`),
    ];
    expect(resolve(['/x', '/y'], paths)).toEqual({ ok: true, paths: ['/x', '/y'] });
  });

  it('drops a file already inside a selected folder', () => {
    const many = Array.from({ length: MAX_SELECTED_RESTORE_FILES }, (_, i) => `/big/f${i}.txt`);
    expect(resolve(['/big', '/big/f1.txt'], many)).toEqual({ ok: true, paths: ['/big'] });
  });

  it('resolves POSIX directories without partial-name matches (pick.txt vs pick.txtx/)', () => {
    const posix = ['/data/pick.txtx/a.txt', '/data/pick.txt', '/data/pick.txt.bak'];
    expect(resolve(['/data/pick.txtx'], posix)).toEqual({ ok: true, paths: ['/data/pick.txtx'] });
    expect(resolve(['/data/pick.txt'], posix)).toEqual({ ok: true, paths: ['/data/pick.txt'] });
  });

  it('resolves UNC directories in their stored form', () => {
    expect(
      resolve(
        ['//fileserver/share/finance'],
        ['\\\\fileserver\\share\\finance\\q3.xlsx', '\\\\fileserver\\share\\finance2\\x']
      )
    ).toEqual({ ok: true, paths: ['\\\\fileserver\\share\\finance'] });
  });

  it('de-duplicates a directory plus a file already inside it', () => {
    expect(resolve(['/a/b', '/a/b/c.txt'], ['/a/b/c.txt', '/a/b/d.txt'])).toEqual({ ok: true, paths: ['/a/b'] });
  });

  it('treats a drive root as a directory (still bounded by its own prefix)', () => {
    expect(resolve(['C:/'], [...stored, 'D:\\other.txt'])).toEqual({ ok: true, paths: ['C:'] });
  });

  it('accepts directory paths exactly as the browse tree returns them (leading slash, UNC without //)', () => {
    expect(resolve(['/C:/Users/alex/Documents'], stored)).toEqual(docsExpected);
    expect(
      resolve(['/fileserver/share/finance'], ['\\\\fileserver\\share\\finance\\q3.xlsx', '\\\\fileserver\\share\\fin\\z'])
    ).toEqual({ ok: true, paths: ['\\\\fileserver\\share\\finance'] });
  });

  it('refuses the bare root "/"', () => {
    expect(resolve(['/'], ['/a/b'])).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('refuses an empty selection', () => {
    expect(resolve([''], ['/a'])).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('a 50,000-file folder resolves to one prefix, not too_many', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => `/big/f${i}.txt`);
    expect(resolve(['/big'], many)).toEqual({ ok: true, paths: ['/big'] });
  });

  it('resolves a parent folder to its own prefix', () => {
    expect(resolve(['C:/Users/alex'], stored)).toEqual({ ok: true, paths: ['C:\\Users\\alex'] });
  });
});

describe('resolve — folders whose files are stored with mixed separators', () => {
  // No one prefix selects every member under the agent's rule, so the folder
  // falls back to listing its files, under the same cap as before.
  const mixed = (count: number) =>
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? `C:\\mix\\f${i}.txt` : `C:/mix/f${i}.txt`));

  it('a mixed folder of 100 expands to its files', () => {
    const files = mixed(100);
    expect(resolve(['C:/mix'], files)).toEqual({ ok: true, paths: files });
  });

  it('a mixed folder of 50,000 is too_many, and names the count', () => {
    const result = resolve(['C:/mix'], mixed(50_000));
    expect(result).toMatchObject({ ok: false, invalidPath: 'C:/mix', reason: 'too_many', limit: MAX_SELECTED_RESTORE_FILES });
    if (!result.ok && result.reason === 'too_many') {
      expect(result.count).toBeGreaterThan(MAX_SELECTED_RESTORE_FILES);
      expect(selectedSnapshotPathError(result)).toContain(String(MAX_SELECTED_RESTORE_FILES));
    }
  });

  it('a mixed folder of exactly the cap is allowed', () => {
    const result = resolve(['C:/mix'], mixed(MAX_SELECTED_RESTORE_FILES));
    expect(result.ok && result.paths.length).toBe(MAX_SELECTED_RESTORE_FILES);
  });

  it('a mixed folder found mixed only after the cap is still too_many, not a short list', () => {
    const files = [...Array.from({ length: MAX_SELECTED_RESTORE_FILES + 5 }, (_, i) => `C:\\mix\\a${i}`), 'C:/mix/z'];
    expect(resolve(['C:/mix'], files)).toMatchObject({ ok: false, reason: 'too_many' });
  });

  it('expanded folders count together toward the cap', () => {
    const half = MAX_SELECTED_RESTORE_FILES / 2 + 1;
    const files = [
      ...Array.from({ length: half }, (_, i) => (i % 2 ? `/x/f${i}` : `\\x\\f${i}`)),
      ...Array.from({ length: half }, (_, i) => (i % 2 ? `/y/f${i}` : `\\y\\f${i}`)),
    ];
    expect(resolve(['/x', '/y'], files)).toMatchObject({ ok: false, reason: 'too_many', invalidPath: '/y' });
  });

  it('the separator collision from restore_test.go: C:\\dir/x.txt and C:/dir\\x.txt', () => {
    const collide = ['C:\\dir/x.txt', 'C:/dir\\x.txt'];
    expect(resolve(['C:/dir'], collide)).toEqual({ ok: true, paths: collide });
  });
});

describe('resolve — a folder spelled so its prefix would also name a file', () => {
  it('a folder selected as `docs\\` beside a file `/docs` does not pull in that file', () => {
    // Found by the agent-parity property test: the prefix `/docs` would make
    // the agent restore the file `/docs` too, which this selection never named.
    const stored = ['/docs', '/docs/a.txt', '/docs/sub/b.txt'];
    expect(resolve(['docs\\'], stored)).toEqual({ ok: true, paths: ['/docs/a.txt', '/docs/sub/b.txt'] });
  });

  it('the same folder selected as the file itself still resolves to one string for both', () => {
    expect(resolve(['/docs'], ['/docs', '/docs/a.txt'])).toEqual({ ok: true, paths: ['/docs'] });
  });
});

describe('resolve — POSIX names containing a backslash', () => {
  it('a\\b and a/b both stored: a selection only their normalized form names is ambiguous', () => {
    expect(resolve(['/srv/x/y'], ['/srv/x\\y', '/srv\\x/y'])).toEqual({ ok: false, invalidPath: '/srv/x/y', reason: 'ambiguous' });
  });

  it('a\\b and a/b both stored: each exact spelling selects only itself', () => {
    expect(resolve(['/srv/a\\b'], ['/srv/a\\b', '/srv/a/b'])).toEqual({ ok: true, paths: ['/srv/a\\b'] });
    expect(resolve(['/srv/a/b'], ['/srv/a\\b', '/srv/a/b'])).toEqual({ ok: true, paths: ['/srv/a/b'] });
  });
});

describe('resolve — input order and duplicates', () => {
  it('gives the same answer whatever order the stored paths arrive in', () => {
    const stored = ['/a/b/c', '/a/b/d', '\\a\\b\\e', '/a/x', '/a/b'];
    const forward = resolve(['/a/b', '/a/x'], stored);
    const backward = resolve(['/a/b', '/a/x'], [...stored].reverse());
    expect(forward.ok && backward.ok).toBe(true);
    if (forward.ok && backward.ok) expect(new Set(backward.paths)).toEqual(new Set(forward.paths));
  });

  it('ignores a stored path repeated, as a keyset walk over duplicate rows may give it', () => {
    expect(resolve(['/a/b.txt'], ['/a/b.txt', '/a/b.txt'])).toEqual({ ok: true, paths: ['/a/b.txt'] });
    expect(resolve(['C:/dir/x.txt'], ['C:\\dir\\x.txt', 'C:\\dir\\x.txt'])).toEqual({ ok: true, paths: ['C:\\dir\\x.txt'] });
  });

  it('with no stored paths at all, every selection is not_found', () => {
    expect(resolve(['/a'], [])).toEqual({ ok: false, invalidPath: '/a', reason: 'not_found' });
  });
});

/** As `resolve`, with the kind of each stored row (#11235). */
function resolveRows(selected: readonly string[], rows: Iterable<{ path: string; kind?: 'dir' | 'symlink' }>) {
  const resolver = createSelectionResolver(selected);
  for (const row of rows) resolver.add(row.path, row.kind ?? null);
  return resolver.finish();
}

describe('resolve — directory and symlink entries (#11235)', () => {
  it('an empty folder selected by its browse path resolves to its own entry', () => {
    expect(resolveRows(['/C:/Data/Empty'], [{ path: 'C:\\Data\\Empty', kind: 'dir' }]))
      .toEqual({ ok: true, paths: ['C:\\Data\\Empty'] });
    expect(resolveRows(['/fileserver/share/empty'], [{ path: '\\\\fileserver\\share\\empty', kind: 'dir' }]))
      .toEqual({ ok: true, paths: ['\\\\fileserver\\share\\empty'] });
    expect(resolveRows(['/srv/empty'], [{ path: '/srv/empty', kind: 'dir' }]))
      .toEqual({ ok: true, paths: ['/srv/empty'] });
  });

  it('a folder whose own entry is recorded still resolves to one prefix, not to its files', () => {
    const rows = [
      { path: 'C:\\Data\\Shared', kind: 'dir' as const },
      { path: 'C:\\Data\\Shared\\a.txt' },
      { path: 'C:\\Data\\Shared\\sub\\b.txt' },
    ];
    expect(resolveRows(['/C:/Data/Shared'], rows)).toEqual({ ok: true, paths: ['C:\\Data\\Shared'] });
    expect(resolveRows(['C:/Data/Shared/'], rows)).toEqual({ ok: true, paths: ['C:\\Data\\Shared'] });
  });

  it('the POSIX `docs\\` case: the folder\'s own entry is part of the folder, not a file beside it', () => {
    const rows = [{ path: '/docs', kind: 'dir' as const }, { path: '/docs/a.txt' }, { path: '/docs/sub/b.txt' }];
    expect(resolveRows(['docs\\'], rows)).toEqual({ ok: true, paths: ['/docs'] });
  });

  it('adds the folder\'s own entry when the prefix, in its members\' spelling, does not select it', () => {
    const rows = [{ path: 'C:/Data/Shared', kind: 'dir' as const }, { path: 'C:\\Data\\Shared\\a.txt' }];
    expect(resolveRows(['/C:/Data/Shared'], rows)).toEqual({ ok: true, paths: ['C:\\Data\\Shared', 'C:/Data/Shared'] });
  });

  it('a folder expanded to its files keeps its own entry', () => {
    const rows = [
      { path: 'C:\\dir', kind: 'dir' as const },
      { path: 'C:\\dir/x.txt' },
      { path: 'C:/dir\\y.txt' },
    ];
    expect(resolveRows(['/C:/dir'], rows)).toEqual({ ok: true, paths: ['C:\\dir', 'C:\\dir/x.txt', 'C:/dir\\y.txt'] });
  });

  it('a folder containing only empty folders resolves to its prefix', () => {
    const rows = [{ path: 'C:\\Data\\a', kind: 'dir' as const }, { path: 'C:\\Data\\b', kind: 'dir' as const }];
    expect(resolveRows(['/C:/Data'], rows)).toEqual({ ok: true, paths: ['C:\\Data'] });
  });

  it('a symlink is selected like a file, by its stored path', () => {
    const rows = [{ path: 'C:\\Data\\link', kind: 'symlink' as const }, { path: '/srv/current', kind: 'symlink' as const }];
    expect(resolveRows(['C:/Data/link'], rows)).toEqual({ ok: true, paths: ['C:\\Data\\link'] });
    expect(resolveRows(['/srv/current'], rows)).toEqual({ ok: true, paths: ['/srv/current'] });
  });

  it('a mixed folder too large to expand counts its own entry with its files in too_many', () => {
    const rows = [
      { path: 'C:\\mix', kind: 'dir' as const },
      ...Array.from({ length: 50_000 }, (_, i) => ({ path: i % 2 === 0 ? `C:\\mix\\f${i}.txt` : `C:/mix/f${i}.txt` })),
    ];
    expect(resolveRows(['/C:/mix'], rows)).toEqual({
      ok: false, invalidPath: '/C:/mix', reason: 'too_many', count: 50_001, limit: MAX_SELECTED_RESTORE_FILES,
    });
  });

  it('a folder recorded under more spellings than are kept is ambiguous, not silently cut short', () => {
    // 17 spellings of the same segments: C:\x, C:\x\, C:\x\\, ...
    const rows = Array.from({ length: 17 }, (_, i) => ({ path: `C:\\x${'\\'.repeat(i)}`, kind: 'dir' as const }));
    expect(resolveRows(['/C:/x'], rows)).toEqual({ ok: false, invalidPath: '/C:/x', reason: 'ambiguous' });
    expect(resolveRows(['/C:/x'], rows.slice(0, 16))).toEqual({ ok: true, paths: rows.slice(0, 16).map((r) => r.path) });
  });

  it('a content-less row of unknown kind (written before kinds were recorded) is not a folder by its browse path', () => {
    expect(resolveRows(['/C:/Data/Empty'], [{ path: 'C:\\Data\\Empty' }]))
      .toEqual({ ok: false, invalidPath: '/C:/Data/Empty', reason: 'not_found' });
    expect(resolveRows(['C:/Data/Empty'], [{ path: 'C:\\Data\\Empty' }]))
      .toEqual({ ok: true, paths: ['C:\\Data\\Empty'] });
  });
});
