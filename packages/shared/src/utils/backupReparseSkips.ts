// #9543: separate the agent's "reparse points were not backed up" note from
// the rest of a backup job's errorLog.
//
// Since #7051 the agent records every reparse point it deliberately skips
// (volume mount points, cloud-file and app-exec-link placeholders, junctions
// it cannot capture) and puts one summary fragment on the job Warning. That
// skip is by design: it adds nothing to errorCount and cannot make a run
// partial. But the API persists Warning (and, on a failed run, Error) into a
// single errorLog string joined by "; ", so a profile with a few hundred
// placeholders buried the one line that said why the run actually failed.
//
// The fragment format is fixed by summarizeSkippedReparsePoints
// (agent/internal/backup/reparse_skip.go) and has not changed since it was
// introduced; every agent that ever wrote it wrote this shape:
//
//   N reparse point(s) were not backed up (junctions and mount points are
//   skipped, not followed; <per-kind counts>): <entry>; <entry>[ (+M more)]
//
// where each <entry> is `path (description)` and at most a few are listed.
// Entries are themselves joined by "; ", so the fragment's end is found by
// counting entries against N rather than by splitting on the separator.
//
// Read-side only (web job views, API attention reasons): the stored errorLog
// is never rewritten. If the fragment cannot be
// delimited with confidence the text is returned unchanged, because hiding
// a real error behind a misparse is worse than the clutter this removes.

export interface ReparseSkipSummary {
  /** Total reparse points the run skipped (N in the fragment). */
  total: number;
  /** The agent's fragment verbatim: per-kind counts and the sampled paths. */
  detail: string;
}

export interface SplitReparseSkipNotice {
  /** errorLog with the reparse fragment removed; null when nothing is left. */
  diagnostic: string | null;
  reparseSkipped: ReparseSkipSummary | null;
}

const SEPARATOR = '; ';

const FRAGMENT_HEADER =
  /(^|; )(\d+) reparse point\(s\) were not backed up \(junctions and mount points are skipped, not followed; [^)]*\): /;

const MORE_SUFFIX = / \(\+(\d+) more\)$/;

// Every entry the agent writes is `path (<kind>...)`, kind being one of the
// three skippedReparsePoint.String() descriptions.
const ENTRY_MARKER = / \((?:junction|volume mount point|other reparse point)\b/;

/**
 * Index just past the end of the reparse fragment whose entries start at
 * `entriesStart`, or -1 when it cannot be delimited. An entry ends at a `)`
 * that is followed by "; " or by the end of the text; the fragment ends
 * after the N-th entry, or earlier at an entry carrying "(+M more)" where
 * M is exactly the number of entries not listed. A candidate entry without
 * the agent's description marker means the count has run past the fragment
 * (or the fragment was damaged), so the whole parse is abandoned rather than
 * absorb a neighbouring error.
 */
function findFragmentEnd(text: string, entriesStart: number, total: number): number {
  let entries = 0;
  let entryStart = entriesStart;
  for (let i = entriesStart; i < text.length; i++) {
    if (text[i] !== ')') continue;
    const atEnd = i === text.length - 1;
    if (!atEnd && !text.startsWith(SEPARATOR, i + 1)) continue;
    entries++;
    const entry = text.slice(entryStart, i + 1);
    if (!ENTRY_MARKER.test(entry)) return -1;
    const more = MORE_SUFFIX.exec(entry);
    if (more && Number(more[1]) === total - entries) return i + 1;
    if (!more && entries === total) return i + 1;
    if (entries >= total) return -1;
    entryStart = i + 1 + SEPARATOR.length;
  }
  return -1;
}

export function splitReparseSkipNotice(errorLog: string | null | undefined): SplitReparseSkipNotice {
  const text = errorLog?.trim() ?? '';
  if (!text) return { diagnostic: null, reparseSkipped: null };

  const unchanged = { diagnostic: text, reparseSkipped: null };
  const header = FRAGMENT_HEADER.exec(text);
  if (!header) return unchanged;

  const total = Number(header[2]);
  if (!Number.isSafeInteger(total) || total < 1) return unchanged;

  const fragmentStart = header.index + (header[1] ?? '').length;
  const end = findFragmentEnd(text, header.index + header[0].length, total);
  if (end < 0) return unchanged;

  const before = text.slice(0, header.index);
  const after = text.slice(end).replace(/^; /, '');
  const diagnostic = [before, after].filter((part) => part.length > 0).join(SEPARATOR);
  return {
    diagnostic: diagnostic || null,
    reparseSkipped: { total, detail: text.slice(fragmentStart, end) },
  };
}
