import { describe, expect, it } from 'vitest';
import { stripInlineIndexDropNote } from './backupFileIndexNote';

const NOTE =
  'snapshot file index omitted (17950 entries): the result exceeded the 4934464 byte server result budget, so per-file restore browsing is unavailable for this snapshot';
const IPC_NOTE =
  'snapshot file index omitted (250 entries): the result exceeded the 900000 byte agent IPC budget, so per-file restore browsing is unavailable for this snapshot';
const W03_NOTE =
  'snapshot file index not sent with the result (17950 entries): the result exceeded the 4934464 byte server result budget; the server reads it from the snapshot manifest';
const OTHER_NOTE = 'detail field(s) omitted (vssMetadata, systemState): the result exceeded the 4934464 byte server result budget';

describe('stripInlineIndexDropNote', () => {
  it.each([
    ['the note alone', `bounded: ${NOTE}`, null, 17950],
    ["after the run's own warning", `vss warning || bounded: ${NOTE}`, 'vss warning', 17950],
    ['before another bounding note', `bounded: ${NOTE}; ${OTHER_NOTE}`, `bounded: ${OTHER_NOTE}`, 17950],
    ['after another bounding note', `bounded: ${OTHER_NOTE}; ${NOTE}`, `bounded: ${OTHER_NOTE}`, 17950],
    ['between own text and another note', `vss warning || bounded: ${NOTE}; ${OTHER_NOTE}`, `vss warning || bounded: ${OTHER_NOTE}`, 17950],
    ['the agent IPC budget variant', `bounded: ${IPC_NOTE}`, null, 250],
    ['the server-reads-it wording', `bounded: ${W03_NOTE}`, null, 17950],
    ['the server-reads-it wording before another note', `bounded: ${W03_NOTE}; ${OTHER_NOTE}`, `bounded: ${OTHER_NOTE}`, 17950],
    ['a failed job joining error and note', `disk full; bounded: ${NOTE}`, 'disk full', 17950],
    ['a failed job with own warning and note', `disk full; vss warning || bounded: ${NOTE}`, 'disk full; vss warning', 17950],
  ])('removes the note: %s', (_label, input, warning, droppedEntries) => {
    expect(stripInlineIndexDropNote(input)).toEqual({ warning, droppedEntries });
  });

  it.each([
    ['a plain warning', 'vss warning'],
    ['another bounding note', `bounded: ${OTHER_NOTE}`],
    ['own text that merely mentions a file index', 'snapshot file index is great'],
    ['the neutralised label in own text', 'bounded : something happened'],
  ])('passes through: %s', (_label, input) => {
    expect(stripInlineIndexDropNote(input)).toEqual({ warning: input, droppedEntries: null });
  });

  it('stays linear on a hostile multi-megabyte warning that repeats the prefix', () => {
    const prefix = 'snapshot file index omitted (1 entries): the result exceeded the ';
    const hostile = prefix.repeat(Math.ceil((5 * 1024 * 1024) / prefix.length));
    const startedAt = performance.now();
    expect(stripInlineIndexDropNote(hostile)).toEqual({ warning: hostile, droppedEntries: null });
    // Generous for a loaded host; the unbounded form takes minutes here.
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('passes through null, undefined and empty as null', () => {
    expect(stripInlineIndexDropNote(null)).toEqual({ warning: null, droppedEntries: null });
    expect(stripInlineIndexDropNote(undefined)).toEqual({ warning: null, droppedEntries: null });
    expect(stripInlineIndexDropNote('')).toEqual({ warning: null, droppedEntries: null });
  });
});
