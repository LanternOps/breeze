// The thin queue's negative leg, N3 (W05, #10749): one tamper, two uses.
//
// N3 asks whether a queue entry whose own CI skips a thinnable job the CI Gate
// did not list is ejected. The tamper is the one a broken or hostile thin-queue
// consumer would make: the `changes` job's `thin_skip` output hard-codes
// `,test-shared,` instead of reading the gate's published selection. The
// candidate then skips `test-shared`, its own `CI Success` counts the skip as
// satisfied, and only the pinned gate can catch it, as
// `thin_skip_unjustified:test-shared`.
//
//   - ci-gate.test.mjs builds the tampered ci.yml from the real tree with
//     `applyN3` and runs it through the gate's real `select` and `verify` (the
//     automated N3, on every PR).
//   - The live N3 runs this file on a throwaway branch:
//       node .github/scripts/thin-queue-n3.mjs apply
//     It also rewrites the three pins in queue-selection.test.mjs that the
//     untampered output line satisfies, so the throwaway passes its own PR CI
//     and can be enqueued (the first live attempt, PR 11583, could not).
//     Runbook: docs/agents/merge-and-deploy.md, "Thin queue negative leg (N3)".
//
// Both directions are idempotent and count their matches, so a ci.yml or test
// change that moves a pinned line turns ci-gate.test.mjs red here instead of
// breaking the runbook silently. Every replacement keeps the line count.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const N3_JOB = 'test-shared';

const CONSUMER = 'thin_skip: ${{ steps.queue_thin.outputs.thin_skip }}';
export const N3_EDITS = Object.freeze([
  { file: '.github/workflows/ci.yml', replacements: [{ from: CONSUMER, to: `thin_skip: ',${N3_JOB},'`, count: 1 }] },
  {
    file: '.github/scripts/queue-selection.test.mjs',
    replacements: [
      // The two literals of the output line, inside single-quoted JS strings.
      { from: CONSUMER, to: `thin_skip: \\',${N3_JOB},\\'`, count: 2 },
      // T6 counts the lines that read the consume step: thin_skip no longer does.
      { from: '  assert.equal(outputLines.length, 3);', to: '  assert.equal(outputLines.length, 2); // N3 throwaway', count: 1 },
    ],
  },
]);

const occurrences = (text, needle) => text.split(needle).length - 1;

// One file's text, tampered (`apply`) or restored (`revert`). Already in the
// target state → unchanged. Anything else (a count that does not match, or a
// mix of both forms) throws, naming the file.
export function n3Text(file, text, direction) {
  const edit = N3_EDITS.find((e) => e.file === file);
  if (!edit) throw Error(`thin-queue-n3: no edit for ${file}`);
  if (direction !== 'apply' && direction !== 'revert') throw Error(`thin-queue-n3: unknown direction ${direction}`);
  let out = text;
  for (const r of edit.replacements) {
    const [from, to] = direction === 'apply' ? [r.from, r.to] : [r.to, r.from];
    const have = occurrences(out, from), done = occurrences(out, to);
    if (have === 0 && done === r.count) continue;
    if (have !== r.count || done !== 0) {
      throw Error(`thin-queue-n3: ${file} has ${have} of ${r.count} matches to ${direction} for ${JSON.stringify(r.from)} and ${done} already done; the N3 tamper is stale`);
    }
    out = out.split(from).join(to);
  }
  return out;
}

export const applyN3 = (file, text) => n3Text(file, text, 'apply');
export const revertN3 = (file, text) => n3Text(file, text, 'revert');

export function main(argv, root) {
  const direction = argv[0];
  if (argv.length !== 1 || !['apply', 'revert'].includes(direction)) {
    process.stderr.write('usage: node .github/scripts/thin-queue-n3.mjs apply|revert\n');
    return 2;
  }
  // Compute every file before writing any, so a stale tamper changes nothing.
  const out = N3_EDITS.map(({ file }) => [file, n3Text(file, readFileSync(join(root, file), 'utf8'), direction)]);
  for (const [file, text] of out) writeFileSync(join(root, file), text);
  process.stdout.write(`thin-queue-n3: ${direction} done (${out.map(([file]) => file).join(', ')})\n`);
  return 0;
}

// Node resolves the main module through symlinks (macOS tmpdir is one), so compare real paths.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), fileURLToPath(new URL('../..', import.meta.url)));
}
