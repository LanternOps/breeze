import { describe, expect, it } from 'vitest';
import { normalizeSnapshotPath, resolveSelectedSnapshotPaths } from './backupSelectedPaths';

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
    ['a directory prefix of a stored file', 'C:/Users/alex/Documents'],
    ['a drive root', 'C:/'],
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
