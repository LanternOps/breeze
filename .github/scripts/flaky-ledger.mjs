// Flaky-test ledger + quarantine (W1, #10744).
//
// `.github/flaky-tests.json` lists known-flaky tests, each tied to an issue and
// expiring at most 30 days after it was added. retry-shard lets a listed test
// fail BOTH attempts without failing the job, under these rules:
//   - the ledger is read from the BASE commit (`git show <base>:…`), never the
//     PR's head, so a PR cannot quarantine its own failure;
//   - the PR must not touch the test file or its sibling source (for Go: any
//     file under the package's directory);
//   - anything unknown fails closed: no base sha, a ledger missing or invalid
//     at base, or a changed-file list that cannot be computed → no quarantine.
//
// Entry: { id, runner, file, issue, added, expires }. `id` is exactly what
// retry-shard reports: vitest `<package-relative file> > <suite> > <test>`,
// go `<import path>.<TopLevelTest>`. `file` is repo-relative (for humans).
//
// Go quarantine is per top-level test: quarantining `pkg.TestX` also covers
// its failing subtests (`pkg.TestX/sub`). retry-shard drops a parent test when
// a subtest failed, so a subtest-level entry could hide the parent's own
// failure; ids naming a subtest are therefore rejected. A package-level
// failure (TestMain, a panic outside a test, a timeout) is never excused.

import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

export const LEDGER_PATH = '.github/flaky-tests.json';
export const RUNNERS = ['vitest-api', 'vitest-web', 'vitest-integration', 'go'];
const MAX_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
// A top-level Go test id: `<import path>.<Test|Fuzz|Example…>`, no subtest.
const GO_TOP_LEVEL = /^\S+\.(?:Test|Fuzz|Example)[A-Za-z0-9_]*$/;

const dayNumber = (s) => {
  if (typeof s !== 'string' || !DATE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t / 86400000;
};

export function validateLedger(entries) {
  if (!Array.isArray(entries)) return ['ledger must be a JSON array'];
  const errors = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `entry ${i}${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const field of ['id', 'file']) {
      if (typeof e[field] !== 'string' || e[field].trim() === '') errors.push(`${at}: ${field} must be a non-empty string`);
    }
    if (!RUNNERS.includes(e.runner)) errors.push(`${at}: runner must be one of ${RUNNERS.join(', ')}`);
    if (!Number.isInteger(e.issue) || e.issue <= 0) errors.push(`${at}: issue must be a positive integer`);
    const added = dayNumber(e.added);
    const expires = dayNumber(e.expires);
    if (added === null) errors.push(`${at}: added must be a real YYYY-MM-DD date`);
    if (expires === null) errors.push(`${at}: expires must be a real YYYY-MM-DD date`);
    if (added !== null && expires !== null) {
      if (expires <= added) errors.push(`${at}: expires must be after added`);
      else if (expires - added > MAX_DAYS) errors.push(`${at}: expires must be at most ${MAX_DAYS} days after added`);
    }
    if (e.runner === 'go' && typeof e.id === 'string' && !GO_TOP_LEVEL.test(e.id)) {
      errors.push(`${at}: a go id must name a top-level test (<import path>.TestX), not a subtest or a package`);
    }
    if (typeof e.id === 'string' && RUNNERS.includes(e.runner)) {
      const key = `${e.runner}\0${e.id}`;
      if (seen.has(key)) errors.push(`${at}: duplicate id for runner ${e.runner}`);
      seen.add(key);
    }
  });
  return errors;
}

const gitOut = (repoRoot, args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

// Never throws: every failure is "nothing quarantined".
export function loadBaseLedger({ baseSha, repoRoot }) {
  if (!baseSha || !SHA.test(baseSha)) return [];
  let entries;
  try {
    entries = JSON.parse(gitOut(repoRoot, ['show', `${baseSha}:${LEDGER_PATH}`]));
  } catch {
    return [];
  }
  const errors = validateLedger(entries);
  if (errors.length) {
    process.stderr.write(`flaky-ledger: ${LEDGER_PATH} at ${baseSha} is invalid, quarantining nothing:\n  ${errors.join('\n  ')}\n`);
    return [];
  }
  return entries;
}

export function activeQuarantine(entries, runner, today) {
  return new Set(entries.filter((e) => e.runner === runner && today <= e.expires).map((e) => e.id));
}

// Two-dot: HEAD is the merge commit atop the base (pull_request merge ref,
// merge_group head), so this is the change the run tests. A three-dot diff
// would need a merge base the depth-1 base fetch does not have.
export function changedFiles({ baseSha, repoRoot }) {
  if (!baseSha || !SHA.test(baseSha)) return null;
  try {
    const out = gitOut(repoRoot, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', baseSha, 'HEAD', '--']);
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

// ── Matching ─────────────────────────────────────────────────────────────

const stripExt = (p) => p.replace(/\.[^./]+$/, '');
const TEST_SUFFIX = /\.(?:test|spec)\.[^./]+$/;

// `paths`: { prefix } for vitest (package dir, e.g. `apps/api/`), or
// { goModule, goDir } for go. Unmappable → touched, which blocks quarantine.
export function failureTouched(failure, changed, paths = {}) {
  if (failure.pkg) {
    const { goModule, goDir } = paths;
    if (!goModule || goDir === undefined) return true;
    let rest;
    if (failure.pkg === goModule) rest = '';
    else if (failure.pkg.startsWith(`${goModule}/`)) rest = failure.pkg.slice(goModule.length + 1);
    else return true;
    const dir = posix.join(goDir || '.', rest || '.');
    const under = dir === '.' ? '' : `${dir}/`;
    return [...changed].some((f) => f.startsWith(under));
  }
  if (!failure.file) return true;
  const file = `${paths.prefix ?? ''}${failure.file}`;
  if (changed.has(file)) return true;
  if (!TEST_SUFFIX.test(file)) return false;
  // foo.test.ts → foo.* beside it, and ../foo.* when it lives in __tests__/.
  const stem = file.replace(TEST_SUFFIX, '');
  const stems = new Set([stem]);
  if (posix.basename(posix.dirname(stem)) === '__tests__') stems.add(posix.join(posix.dirname(posix.dirname(stem)), posix.basename(stem)));
  return [...changed].some((f) => stems.has(stripExt(f)));
}

export function isQuarantined(failure, quarantine) {
  if (!failure.pkg) return quarantine.has(failure.id);
  const prefix = `${failure.pkg}.`;
  if (failure.id === failure.pkg || !failure.id.startsWith(prefix)) return false;
  const topLevel = failure.id.slice(prefix.length).split('/')[0];
  return quarantine.has(`${prefix}${topLevel}`);
}
