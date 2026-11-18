import { describe, expect, it } from 'vitest';
import { splitReparseSkipNotice } from './backupReparseSkips';

// Fixtures are byte-for-byte what the agent's summarizeSkippedReparsePoints
// (agent/internal/backup/reparse_skip.go) writes into the job Warning, which
// the API persists to errorLog joined with any other fragments by "; ".
const HEADER = 'reparse point(s) were not backed up (junctions and mount points are skipped, not followed;';

const capped =
  `159 ${HEADER} 3 junction, 1 volume mount point, 155 other): ` +
  'C:\\Users\\a\\My Music (junction -> \\\\server\\share\\Music); ' +
  'C:\\Mounts\\Data (volume mount point -> \\\\?\\Volume{x}\\); ' +
  'C:\\Program Files (x86)\\App\\x.exe (other reparse point, tag 0x8000001B); ' +
  'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe (other reparse point, tag 0x8000001B); ' +
  'C:\\Users\\b\\OneDrive (other reparse point, tag 0x9000701A, reparse data unreadable: Access is denied.) (+154 more)';

const uncapped =
  `2 ${HEADER} 2 other): ` +
  'C:\\a.exe (other reparse point, tag 0x8000001B); ' +
  'C:\\b.exe (other reparse point, tag 0x8000001B)';

describe('splitReparseSkipNotice (#9543)', () => {
  it('returns no notice and the text unchanged when there is no reparse fragment', () => {
    expect(splitReparseSkipNotice('disk full')).toEqual({ diagnostic: 'disk full', reparseSkipped: null });
    expect(splitReparseSkipNotice(null)).toEqual({ diagnostic: null, reparseSkipped: null });
    expect(splitReparseSkipNotice('   ')).toEqual({ diagnostic: null, reparseSkipped: null });
  });

  it('pulls a reparse-only warning out entirely, leaving no diagnostic', () => {
    const out = splitReparseSkipNotice(capped);
    expect(out.diagnostic).toBeNull();
    expect(out.reparseSkipped).toEqual({ total: 159, detail: capped });
  });

  it('keeps the real failure reason when a stopped run also skipped reparse points', () => {
    const out = splitReparseSkipNotice(`backup stopped; ${capped}`);
    expect(out.diagnostic).toBe('backup stopped');
    expect(out.reparseSkipped?.total).toBe(159);
  });

  it('keeps fragments on both sides of a capped reparse fragment', () => {
    const before = 'VSS shadow copy could not be created, every path was read live';
    const after =
      '3 file(s) could not be read during the backup scan: C:\\locked.db (permission denied); C:\\x (in use)';
    const out = splitReparseSkipNotice(`${before}; ${capped}; ${after}`);
    expect(out.diagnostic).toBe(`${before}; ${after}`);
    expect(out.reparseSkipped).toEqual({ total: 159, detail: capped });
  });

  it('ends an uncapped fragment after exactly `total` entries', () => {
    const after = '1 file(s) were modified while being backed up (recorded as volatile)';
    const out = splitReparseSkipNotice(`${uncapped}; ${after}`);
    expect(out.diagnostic).toBe(after);
    expect(out.reparseSkipped).toEqual({ total: 2, detail: uncapped });
  });

  it('leaves the text untouched when the fragment cannot be delimited', () => {
    // Claims 4 entries, lists 2, no "(+N more)" — a truncated or reworded
    // fragment. Showing it raw beats hiding a real error after it.
    const broken = `4 ${HEADER} 4 other): C:\\a (other reparse point); C:\\b (other reparse point)`;
    const text = `${broken}; 2 file(s) failed to upload`;
    expect(splitReparseSkipNotice(text)).toEqual({ diagnostic: text, reparseSkipped: null });
  });

  it('never counts a following fragment as an entry when an entry lost its closing paren', () => {
    // The API redacts secrets with a `[^\s]+` value pattern, which can eat an
    // entry's trailing `)`. The scan must not then swallow the next fragment.
    const damaged =
      `2 ${HEADER} 2 other): C:\\token=[REDACTED]; C:\\b.exe (other reparse point, tag 0x8000001B)`;
    const after = '1 file(s) were modified while being backed up (recorded as volatile)';
    const text = `${damaged}; ${after}`;
    expect(splitReparseSkipNotice(text)).toEqual({ diagnostic: text, reparseSkipped: null });
  });

  it('never borrows parenthesised entries from a real error to make up an under-listed fragment', () => {
    const shortList = `4 ${HEADER} 4 other): C:\\a (other reparse point); C:\\b (other reparse point)`;
    const scanError =
      '3 file(s) could not be read during the backup scan: C:\\l.db (permission denied); C:\\x (in use)';
    const text = `${shortList}; ${scanError}`;
    expect(splitReparseSkipNotice(text)).toEqual({ diagnostic: text, reparseSkipped: null });
  });

  it('shows the text raw when a path inside the fragment contains "); "', () => {
    const odd =
      `3 ${HEADER} 3 other): C:\\a (copy); x (other reparse point); C:\\b (other reparse point); C:\\c (other reparse point)`;
    const text = `${odd}; disk full (code 5)`;
    expect(splitReparseSkipNotice(text)).toEqual({ diagnostic: text, reparseSkipped: null });
  });

  it('keeps a real error after a capped fragment whose "(+M more)" does not add up', () => {
    const bad = `9 ${HEADER} 9 other): C:\\a (other reparse point) (+3 more)`;
    const text = `${bad}; real failure (err)`;
    expect(splitReparseSkipNotice(text)).toEqual({ diagnostic: text, reparseSkipped: null });
  });

  it('does not match the phrase mid-fragment', () => {
    const text = 'agent said: 5 reparse point(s) were not backed up (junctions and mount points are skipped, not followed; 5 other): x (other reparse point) (+4 more)';
    expect(splitReparseSkipNotice(text)).toEqual({ diagnostic: text, reparseSkipped: null });
  });
});
