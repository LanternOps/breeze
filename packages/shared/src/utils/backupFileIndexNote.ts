// #11026: recognise the note the backup helper appends to a run's warning when
// the snapshot's file list did not fit in the result. The list is not lost: it
// lives in the snapshot's manifest, and the server builds the index from there.
// So the note describes a recoverable delivery detail, not a job problem, and
// it must not be stored or shown as a warning.
//
// The note's text and its forms are fixed by emptySnapshotFiles and
// appendResultWarning (agent/cmd/breeze-backup/result_bounds.go):
//
//   bounded: <note>
//   <own warning> || bounded: <note>
//   bounded: <note>; <other note>
//   bounded: <other note>; <note>
//
// and a failed job's persisted errorLog may prepend `<error>; ` to any of them.
// Agents have written the "omitted" wording since the note was introduced; the
// "not sent with the result" wording is what the helper will write once it
// stops claiming browsing is unavailable.

const NOTE_LABEL = 'bounded: ';
const OWN_TEXT_MARKER = ' || ';
const NOTE_JOINER = '; ';

// Bounded quantifiers: the warning is agent-supplied and can be megabytes, and
// this runs on the API's main thread. The limit text is only
// `<n> byte <label>` (deliveryLimit.describe), so an unbounded run here would
// only give a hostile agent quadratic backtracking.
const INDEX_DROP_NOTE =
  /snapshot file index (?:omitted|not sent with the result) \((\d{1,15}) entries\): the result exceeded the [^;,]{0,128}(?:, so per-file restore browsing is unavailable for this snapshot|; the server reads it from the snapshot manifest)/;

export interface StrippedInlineIndexDropNote {
  /** The warning with the note removed; null when nothing is left. */
  warning: string | null;
  /** Entries the note says were dropped; null when there was no note. */
  droppedEntries: number | null;
}

export function stripInlineIndexDropNote(warning: string | null | undefined): StrippedInlineIndexDropNote {
  if (!warning) return { warning: null, droppedEntries: null };
  const match = INDEX_DROP_NOTE.exec(warning);
  if (!match) return { warning, droppedEntries: null };

  let before = warning.slice(0, match.index);
  let after = warning.slice(match.index + match[0].length);

  if (before.endsWith(NOTE_LABEL)) {
    if (after.startsWith(NOTE_JOINER)) {
      // First of several notes: the next one takes over the label.
      after = after.slice(NOTE_JOINER.length);
    } else {
      // The only note: the label and what joined it to the own text go too.
      before = before.slice(0, -NOTE_LABEL.length);
      if (before.endsWith(OWN_TEXT_MARKER)) before = before.slice(0, -OWN_TEXT_MARKER.length);
      else if (before.endsWith(NOTE_JOINER)) before = before.slice(0, -NOTE_JOINER.length);
    }
  } else if (before.endsWith(NOTE_JOINER)) {
    before = before.slice(0, -NOTE_JOINER.length);
  }

  const rest = before + after;
  return { warning: rest.length > 0 ? rest : null, droppedEntries: Number(match[1]) };
}
