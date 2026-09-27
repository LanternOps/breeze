#!/usr/bin/env node
// Parser for .github/release-provenance/server-only-tags.tsv.
//
//   row      --ref REF --tag TAG          print the row (TSV); exit 3 = not listed
//   tags     --ref REF                    print every listed tag
//   validate --ref REF                    parse the ledger at REF; exit 1 on error
//   changed  --base-ref A --head-ref B    print "<added|changed|removed>\t<tag>\t<commit>\t<base>" per row
//
// Exit 3 means exactly "this tag is not a server-only release". Every other
// failure (unresolvable ref, malformed ledger) exits 1 so a caller can never
// mistake an error for the safe full-release default.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_PATH = '.github/release-provenance/server-only-tags.tsv';
const STABLE_TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const NOT_LISTED = 3;

class LedgerError extends Error {}

function fail(message) {
  throw new LedgerError(message);
}

export function isStableTag(tag) {
  return STABLE_TAG_RE.test(tag ?? '');
}

export function parseLedger(text) {
  const rows = [];
  const tags = new Set();
  const commits = new Set();
  for (const [index, line] of text.split('\n').entries()) {
    const lineNumber = index + 1;
    const content = line.replace(/\r$/u, '');
    if (content.trim() === '' || content.startsWith('#')) continue;
    const fields = content.split('\t');
    if (fields.length !== 4 || fields.some((field) => field.trim() === '')) {
      fail(`ledger row ${lineNumber}: expected four non-empty tab-separated fields`);
    }
    const [tag, commit, base, note] = fields;
    if (!isStableTag(tag)) fail(`ledger row ${lineNumber}: '${tag}' is not a stable release tag (vMAJOR.MINOR.PATCH)`);
    if (!COMMIT_RE.test(commit)) fail(`ledger row ${lineNumber}: commit '${commit}' is not a 40-hex commit id`);
    if (!isStableTag(base)) fail(`ledger row ${lineNumber}: base must be a stable release tag, got '${base}'`);
    if (base === tag) fail(`ledger row ${lineNumber}: base must differ from the tag`);
    if (tags.has(tag)) fail(`ledger row ${lineNumber}: duplicate tag ${tag}`);
    if (commits.has(commit)) fail(`ledger row ${lineNumber}: duplicate commit ${commit}`);
    tags.add(tag);
    commits.add(commit);
    rows.push({ tag, commit, base, note, line: lineNumber });
  }
  return rows;
}

const rowKey = ({ tag, commit, base, note }) => [tag, commit, base, note].join('\t');

export function diffLedger(oldText, newText) {
  const before = new Map(parseLedger(oldText).map((entry) => [entry.tag, entry]));
  const current = new Map(parseLedger(newText).map((entry) => [entry.tag, entry]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [tag, entry] of current) {
    const previous = before.get(tag);
    if (!previous) added.push(entry);
    else if (rowKey(previous) !== rowKey(entry)) changed.push(entry);
  }
  for (const [tag, entry] of before) {
    if (!current.has(tag)) removed.push(entry);
  }
  return { added, changed, removed };
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// Returns the ledger text at REF, or '' when the file does not exist there.
// An unresolvable REF is an error, never an empty ledger.
export function ledgerTextAt(ref) {
  const resolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (resolved.status !== 0) fail(`cannot resolve ref '${ref}'`);
  const exists = git(['cat-file', '-e', `${resolved.stdout.trim()}:${LEDGER_PATH}`]);
  if (exists.status !== 0) return '';
  const shown = git(['show', `${resolved.stdout.trim()}:${LEDGER_PATH}`]);
  if (shown.status !== 0) fail(`cannot read ${LEDGER_PATH} at '${ref}': ${shown.stderr.trim()}`);
  return shown.stdout;
}

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.includes(key) || value === undefined || value === '') fail(`unexpected or empty argument ${key ?? ''}`);
    options[key.slice(2)] = value;
  }
  for (const key of allowed) {
    if (!(key.slice(2) in options)) fail(`missing ${key}`);
  }
  return options;
}

const formatRow = ({ tag, commit, base, note }) => `${tag}\t${commit}\t${base}\t${note}\n`;

function runCli(argv) {
  const [command, ...args] = argv;
  if (command === 'row') {
    const options = parseOptions(args, ['--ref', '--tag']);
    const match = parseLedger(ledgerTextAt(options.ref)).find((entry) => entry.tag === options.tag);
    if (!match) {
      process.stderr.write(`${options.tag} is not listed in ${LEDGER_PATH} at ${options.ref}\n`);
      return NOT_LISTED;
    }
    process.stdout.write(formatRow(match));
    return 0;
  }
  if (command === 'tags') {
    const options = parseOptions(args, ['--ref']);
    for (const entry of parseLedger(ledgerTextAt(options.ref))) process.stdout.write(`${entry.tag}\n`);
    return 0;
  }
  if (command === 'validate') {
    const options = parseOptions(args, ['--ref']);
    const rows = parseLedger(ledgerTextAt(options.ref));
    process.stdout.write(`${LEDGER_PATH} at ${options.ref}: ${rows.length} row(s), valid\n`);
    return 0;
  }
  if (command === 'changed') {
    const options = parseOptions(args, ['--base-ref', '--head-ref']);
    const diff = diffLedger(ledgerTextAt(options['base-ref']), ledgerTextAt(options['head-ref']));
    for (const kind of ['added', 'changed', 'removed']) {
      for (const entry of diff[kind]) process.stdout.write(`${kind}\t${entry.tag}\t${entry.commit}\t${entry.base}\n`);
    }
    return 0;
  }
  fail('usage: server-only-ledger.mjs <row --ref REF --tag TAG | tags --ref REF | validate --ref REF | changed --base-ref A --head-ref B>');
  return 1;
}

// Compare real paths: the guard runs these helpers from a temporary directory
// that may sit behind a symlink (/var -> /private/var on macOS). A plain URL
// comparison would then silently skip the CLI and exit 0 with no output.
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
