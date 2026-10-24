import { describe, expect, it } from 'vitest';
import {
  MAX_SELECTED_RESTORE_FILES,
  normalizeSnapshotPath,
  resolveSelectedSnapshotPaths,
  selectedSnapshotPathError,
} from './backupSelectedPaths';

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

describe('resolveSelectedSnapshotPaths', () => {
  const windowsStored = [
    'C:\\Users\\alex\\Documents\\invoice.pdf',
    'C:\\Users\\alex\\Documents\\report.docx',
    '\\\\fileserver\\share\\finance\\q3.xlsx',
  ];

  it('maps a forward-slash Windows drive path (as shown by the browse tree) back to the stored original', () => {
    expect(
      resolveSelectedSnapshotPaths(['C:/Users/alex/Documents/invoice.pdf'], windowsStored)
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\invoice.pdf'] });
  });

  it('maps a forward-slash UNC path back to the stored original', () => {
    expect(
      resolveSelectedSnapshotPaths(['//fileserver/share/finance/q3.xlsx'], windowsStored)
    ).toEqual({ ok: true, paths: ['\\\\fileserver\\share\\finance\\q3.xlsx'] });
  });

  it('maps a mixed-separator selection back to the stored original', () => {
    expect(
      resolveSelectedSnapshotPaths(['C:\\Users/alex\\Documents/report.docx'], windowsStored)
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\report.docx'] });
  });

  it('accepts the stored original verbatim', () => {
    expect(
      resolveSelectedSnapshotPaths(['C:\\Users\\alex\\Documents\\invoice.pdf'], windowsStored)
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\invoice.pdf'] });
  });

  it('de-duplicates two spellings of the same file', () => {
    expect(
      resolveSelectedSnapshotPaths(
        ['C:/Users/alex/Documents/invoice.pdf', 'C:\\Users\\alex\\Documents\\invoice.pdf'],
        windowsStored
      )
    ).toEqual({ ok: true, paths: ['C:\\Users\\alex\\Documents\\invoice.pdf'] });
  });

  it('keeps Linux and macOS paths working unchanged', () => {
    const stored = ['/home/alex/notes.txt', '/Users/alex/Library/prefs.plist'];
    expect(
      resolveSelectedSnapshotPaths(['/home/alex/notes.txt', '/Users/alex/Library/prefs.plist'], stored)
    ).toEqual({ ok: true, paths: ['/home/alex/notes.txt', '/Users/alex/Library/prefs.plist'] });
  });

  it('prefers an exact match over a separator-normalized one on POSIX paths containing a backslash', () => {
    // On Linux a backslash is a legal filename character, so both files can
    // coexist and normalize to the same key. An exact selection must pick
    // exactly the file named, never its look-alike.
    const stored = ['/srv/a\\b.txt', '/srv/a/b.txt'];
    expect(resolveSelectedSnapshotPaths(['/srv/a/b.txt'], stored)).toEqual({ ok: true, paths: ['/srv/a/b.txt'] });
    expect(resolveSelectedSnapshotPaths(['/srv/a\\b.txt'], stored)).toEqual({ ok: true, paths: ['/srv/a\\b.txt'] });
  });

  it('refuses a normalized selection that maps to more than one stored file', () => {
    // Neither stored path equals the selection and both normalize to it:
    // picking one would be a guess, so the selection is refused.
    const collide = ['C:\\dir/x.txt', 'C:/dir\\x.txt'];
    expect(resolveSelectedSnapshotPaths(['C:/dir/x.txt'], collide)).toEqual({
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
    expect(resolveSelectedSnapshotPaths([selection], windowsStored)).toEqual({
      ok: false,
      invalidPath: selection,
      reason: 'not_found',
    });
  });

  it('reports the first unavailable selection and resolves nothing', () => {
    expect(
      resolveSelectedSnapshotPaths(
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
    const result = resolveSelectedSnapshotPaths(selections, windowsStored);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const path of result.paths) expect(windowsStored).toContain(path);
    }
  });
});

describe('resolveSelectedSnapshotPaths — directory expansion (#9628)', () => {
  const stored = [
    'C:\\Users\\alex\\Documents\\invoice.pdf',
    'C:\\Users\\alex\\Documents\\sub\\deep.txt',
    'C:\\Users\\alex\\Documents2\\other.txt',
    'C:\\Users\\alex\\Documentsx',
  ];
  const docsExpected = {
    ok: true,
    paths: ['C:\\Users\\alex\\Documents\\invoice.pdf', 'C:\\Users\\alex\\Documents\\sub\\deep.txt'],
  };

  it('expands a directory to every stored file beneath it (nested included)', () => {
    expect(resolveSelectedSnapshotPaths(['C:/Users/alex/Documents'], stored)).toEqual(docsExpected);
  });

  it('accepts the directory with a backslash spelling or trailing separator', () => {
    expect(resolveSelectedSnapshotPaths(['C:\\Users\\alex\\Documents'], stored)).toEqual(docsExpected);
    expect(resolveSelectedSnapshotPaths(['C:/Users/alex/Documents/'], stored)).toEqual(docsExpected);
  });

  it('does not match sibling directories or files sharing a name prefix', () => {
    expect(resolveSelectedSnapshotPaths(['C:/Users/alex/Documents'], stored)).toEqual(docsExpected);
  });

  it.each([
    ['a trailing dot-segment', 'C:/Users/alex/Documents/..'],
    ['a dot-segment inside the directory', 'C:/Users/alex/Temp/../Documents'],
    ['a case-variant directory', 'c:/users/alex/documents'],
  ])('refuses %s as a directory selection', (_label, selection) => {
    expect(resolveSelectedSnapshotPaths([selection], stored)).toEqual({
      ok: false,
      invalidPath: selection,
      reason: 'not_found',
    });
  });

  it('expands a folder that shares its name with a file (b and b/…) instead of dropping the contents', () => {
    expect(resolveSelectedSnapshotPaths(['/a/b'], ['/a/b', '/a/b/c.txt', '/a/bb/d.txt'])).toEqual({
      ok: true,
      paths: ['/a/b', '/a/b/c.txt'],
    });
  });

  it('reports too_many when several selections that each fit exceed the cap together', () => {
    const half = MAX_SELECTED_RESTORE_FILES / 2 + 1;
    const paths = [
      ...Array.from({ length: half }, (_, i) => `/x/f${i}`),
      ...Array.from({ length: half }, (_, i) => `/y/f${i}`),
    ];
    expect(resolveSelectedSnapshotPaths(['/x', '/y'], paths)).toMatchObject({
      ok: false,
      reason: 'too_many',
      invalidPath: '/y',
    });
  });

  it('does not double count overlapping selections toward the cap', () => {
    const many = Array.from({ length: MAX_SELECTED_RESTORE_FILES }, (_, i) => `/big/f${i}.txt`);
    const result = resolveSelectedSnapshotPaths(['/big', '/big/f1.txt'], many);
    expect(result.ok && result.paths.length).toBe(MAX_SELECTED_RESTORE_FILES);
  });

  it('expands POSIX directories without partial-name matches (pick.txt vs pick.txtx/)', () => {
    const posix = ['/data/pick.txtx/a.txt', '/data/pick.txt', '/data/pick.txt.bak'];
    expect(resolveSelectedSnapshotPaths(['/data/pick.txtx'], posix)).toEqual({
      ok: true,
      paths: ['/data/pick.txtx/a.txt'],
    });
    expect(resolveSelectedSnapshotPaths(['/data/pick.txt'], posix)).toEqual({ ok: true, paths: ['/data/pick.txt'] });
  });

  it('expands UNC directories', () => {
    expect(
      resolveSelectedSnapshotPaths(
        ['//fileserver/share/finance'],
        ['\\\\fileserver\\share\\finance\\q3.xlsx', '\\\\fileserver\\share\\finance2\\x']
      )
    ).toEqual({ ok: true, paths: ['\\\\fileserver\\share\\finance\\q3.xlsx'] });
  });

  it('de-duplicates a directory plus a file already inside it', () => {
    expect(resolveSelectedSnapshotPaths(['/a/b', '/a/b/c.txt'], ['/a/b/c.txt', '/a/b/d.txt'])).toEqual({
      ok: true,
      paths: ['/a/b/c.txt', '/a/b/d.txt'],
    });
  });

  it('treats a drive root as a directory (still bounded by its own prefix and the cap)', () => {
    const result = resolveSelectedSnapshotPaths(['C:/'], [...stored, 'D:\\other.txt']);
    expect(result).toEqual({ ok: true, paths: stored });
  });

  it('accepts directory paths exactly as the browse tree returns them (leading slash, UNC without //)', () => {
    expect(resolveSelectedSnapshotPaths(['/C:/Users/alex/Documents'], stored)).toEqual(docsExpected);
    expect(
      resolveSelectedSnapshotPaths(['/fileserver/share/finance'], ['\\\\fileserver\\share\\finance\\q3.xlsx', '\\\\fileserver\\share\\fin\\z'])
    ).toEqual({ ok: true, paths: ['\\\\fileserver\\share\\finance\\q3.xlsx'] });
  });

  it('refuses the bare root "/"', () => {
    expect(resolveSelectedSnapshotPaths(['/'], ['/a/b'])).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('refuses an empty selection', () => {
    expect(resolveSelectedSnapshotPaths([''], ['/a'])).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('refuses an expansion above the cap and names the count', () => {
    const many = Array.from({ length: MAX_SELECTED_RESTORE_FILES + 1 }, (_, i) => `/big/f${i}.txt`);
    const result = resolveSelectedSnapshotPaths(['/big'], many);
    expect(result).toEqual({
      ok: false,
      invalidPath: '/big',
      reason: 'too_many',
      count: MAX_SELECTED_RESTORE_FILES + 1,
      limit: MAX_SELECTED_RESTORE_FILES,
    });
    if (!result.ok) {
      expect(selectedSnapshotPathError(result)).toContain(String(MAX_SELECTED_RESTORE_FILES + 1));
    }
  });

  it('allows exactly the cap', () => {
    const many = Array.from({ length: MAX_SELECTED_RESTORE_FILES }, (_, i) => `/big/f${i}.txt`);
    const result = resolveSelectedSnapshotPaths(['/big'], many);
    expect(result.ok && result.paths.length).toBe(MAX_SELECTED_RESTORE_FILES);
  });

  it('expands a parent folder to every stored original beneath it, in stored order', () => {
    expect(resolveSelectedSnapshotPaths(['C:/Users/alex'], stored)).toEqual({ ok: true, paths: stored });
  });
});
