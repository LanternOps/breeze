#!/usr/bin/env node
// Whole-shard retry with a flake report (W1, #10744).
//
// GitHub's merge queue has no retry: one flaky test fails a shard, `CI Success`
// goes red, the PR is ejected and every entry queued behind it rebuilds. This
// wrapper runs a test command and, when it failed with failures it can SEE,
// runs it exactly once more:
//   - vitest: the identical command, so the whole shard re-runs (never a
//     subset of a shard — a subset would change test ordering/isolation);
//   - go: the same `go test` flags restricted to the failed packages.
// It never retries what it cannot see (no parsed failures: install error, DB
// not ready, a crash before the summary), a build failure, a Go data race,
// or a signal-killed run. A test that fails on both attempts fails the job.
//
//   node .github/scripts/retry-shard.mjs --runner vitest|go --label <name> \
//     [--go-dir <dir>] -- <command...>
//
// A test that fails both attempts may still pass the job when it is in the
// flaky ledger (.github/flaky-tests.json) AT THE BASE COMMIT ($CI_BASE_SHA)
// and the change touched neither it nor its sibling source — see
// flaky-ledger.mjs. No $CI_BASE_SHA → no quarantine.
//
// When the first attempt fails it writes flake-report-<label>.json
// ({label, attempts, flaky, quarantined, exitCode}) in the working directory,
// appends a table to $GITHUB_STEP_SUMMARY and prints a `::warning` per flaky
// test. The exit code is decide().exitCode.

import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { activeEntries, changedFiles, failureTouched, isQuarantined, loadBaseLedger } from './flaky-ledger.mjs';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// ── Failure parsing ──────────────────────────────────────────────────────

// Vitest's default reporter prints a `⎯⎯ Failed Suites N ⎯⎯` / `⎯⎯ Failed
// Tests N ⎯⎯` section after the run, one ` FAIL  <file> > <suite> > <test>`
// line per failure (` FAIL  <file> [ <file> ]` for a suite that failed to
// load). CI turns colour on (`CI` is set), so ANSI codes are stripped first.
// Only lines after the section header count: a test's console output can
// contain anything, including a line starting with FAIL.
const VITEST_SECTION = /Failed (?:Tests|Suites) \d+/;
const VITEST_FAIL = /^\s*FAIL\s+(\S.*?)\s*$/;

// `unattributed`: a failure the per-test parse cannot pin on a test —
// vitest's `Unhandled Errors` section exits 1 even when every test passed. It
// never blocks a retry; it stops quarantine from excusing the attempt, since
// the parsed failures would not explain the whole exit code. Text match
// anywhere (console noise included): a false hit only blocks quarantine.
const VITEST_UNHANDLED = /Unhandled (?:Errors?|Rejection)/;

function parseVitest(output) {
  const failures = [];
  const seen = new Set();
  let inSummary = false;
  let unattributed = false;
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '').replace(/\r$/, '');
    if (VITEST_UNHANDLED.test(line)) unattributed = true;
    if (VITEST_SECTION.test(line)) {
      inSummary = true;
      continue;
    }
    if (!inSummary) continue;
    const m = VITEST_FAIL.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    // Split on the first ` > ` only: test names may contain ` > ` themselves.
    const head = m[1].split(' > ')[0];
    failures.push({ id: m[1], file: head.replace(/\s+\[.*\]$/, '').trim(), pkg: null });
  }
  return { failures, buildFailed: false, raceDetected: false, unattributed };
}

// `go test -json` events. A failing subtest also fails its parent; the parent
// is dropped when a descendant failed (it adds nothing and would stop a
// subtest from ever being matched on its own), and a package-level fail is
// reported only when no test in that package failed (TestMain, a panic, a
// timeout). Build/setup failures are never retried, and neither is a data
// race: the race detector reports an interleaving that happened, so a clean
// second attempt would only hide a real (intermittent) bug.
const GO_BUILD_FAILED = /^FAIL\t\S+ \[(?:build|setup) failed\]/;
const GO_DATA_RACE = 'WARNING: DATA RACE';

// The package-level fail is deduped out of `failures` when a test in that
// package failed (it would only widen the retry). That must not let a failing
// package look fully explained by its failed tests, so `unattributed` is set
// when a FAILED package shows anything beyond ordinary test failures:
//   - a panic (`panic: …` at column 0, which t.Log never produces — the rest
//     of the package's tests never ran), a `-timeout` (`test timed out`), or
//     `[setup failed]`, in any of the package's output;
//   - a package-level output line (no Test) that is not standard go test
//     framing, e.g. TestMain reporting a leak after m.Run();
// and, in any package, a test that emitted `run` without ever reaching
// pass/fail/skip.
const GO_PKG_MARKER = /^panic: |test timed out after|\[setup failed\]/m;
const GO_STANDARD_PKG_LINE = [
  /^$/,
  /^(?:PASS|FAIL)$/,
  /^ok\s+\S+/,
  /^FAIL\t\S+\t[\d.]+s(?:\t.*)?$/,
  /^\?\s+\S+\s+\[no test files\]$/,
  /^coverage: /,
  /^exit status \d+$/,
  /^testing: warning: no tests to run$/,
  /^(?:=== (?:RUN|PAUSE|CONT|NAME)|--- (?:FAIL|PASS|SKIP):) /,
];

function goUnattributed(pkgLines, markers, failedPkgs, started, finished) {
  for (const key of started) if (!finished.has(key)) return true;
  for (const pkg of failedPkgs) {
    if (markers.has(pkg)) return true;
    for (const line of pkgLines.get(pkg) ?? []) {
      if (!GO_STANDARD_PKG_LINE.some((re) => re.test(line))) return true;
    }
  }
  return false;
}

function parseGo(output) {
  const fails = [];
  let buildFailed = false;
  let raceDetected = false;
  const pkgLines = new Map(); // package-level (no Test) output lines
  const markers = new Set(); // packages with a panic/timeout/setup-failed line
  const failedPkgs = new Set();
  const started = new Set();
  const finished = new Set();
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) {
      if (line.includes(GO_DATA_RACE)) raceDetected = true;
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      if (line.includes(GO_DATA_RACE)) raceDetected = true;
      continue;
    }
    if (typeof ev.Output === 'string' && ev.Output.includes(GO_DATA_RACE)) raceDetected = true;
    if (ev.Action === 'build-fail') buildFailed = true;
    if (ev.Action === 'output' && typeof ev.Output === 'string' && GO_BUILD_FAILED.test(ev.Output)) buildFailed = true;
    if (ev.Package && ev.Action === 'output' && typeof ev.Output === 'string') {
      if (GO_PKG_MARKER.test(ev.Output)) markers.add(ev.Package);
      if (!ev.Test) {
        if (!pkgLines.has(ev.Package)) pkgLines.set(ev.Package, []);
        pkgLines.get(ev.Package).push(...ev.Output.replace(/\r/g, '').split('\n').filter((l) => l !== ''));
      }
    }
    if (ev.Package && ev.Test) {
      const key = `${ev.Package}\0${ev.Test}`;
      if (ev.Action === 'run') started.add(key);
      if (['pass', 'fail', 'skip'].includes(ev.Action)) finished.add(key);
    }
    if (ev.Action !== 'fail' || !ev.Package) continue;
    if (!ev.Test) failedPkgs.add(ev.Package);
    if (ev.FailedBuild) buildFailed = true;
    fails.push({ pkg: ev.Package, test: ev.Test ?? null });
  }
  const failedTests = fails.filter((f) => f.test);
  const failures = [];
  const seen = new Set();
  for (const f of fails) {
    let id;
    if (f.test) {
      const hasFailingChild = failedTests.some((o) => o.pkg === f.pkg && o.test.startsWith(`${f.test}/`));
      if (hasFailingChild) continue;
      id = `${f.pkg}.${f.test}`;
    } else {
      if (failedTests.some((o) => o.pkg === f.pkg)) continue;
      id = f.pkg;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    failures.push({ id, file: null, pkg: f.pkg });
  }
  const unattributed = goUnattributed(pkgLines, markers, failedPkgs, started, finished);
  return { failures, buildFailed, raceDetected, unattributed };
}

export function parseFailures(runner, output) {
  if (runner === 'vitest') return parseVitest(output);
  if (runner === 'go') return parseGo(output);
  throw new Error(`unknown runner: ${runner}`);
}

// ── Decision ─────────────────────────────────────────────────────────────

// Pure: called with `second: null` to ask whether to retry, then again with
// the second attempt's result for the final verdict.
//
// Quarantine applies only after a real second attempt failed with parsed
// failures and nothing else (no signal, build failure, data race, and no
// unattributed failure on EITHER attempt), and only when `changedFiles` is
// known: every failure must be in `quarantine` (see isQuarantined) with its
// file/package untouched (failureTouched, `paths` maps it to a repo-relative
// path). Otherwise the second attempt's exit code stands. A quarantined
// verdict still reports as flaky the first-attempt failures that passed on
// the retry.
export function decide({ first, second, quarantine = new Set(), changedFiles = null, paths = {} }) {
  const none = { flaky: [], quarantined: [] };
  if (first.code === 0) return { exitCode: 0, retry: false, ...none };
  if (first.code === null || first.buildFailed || first.raceDetected || first.failures.length === 0) {
    return { exitCode: first.code ?? 1, retry: false, ...none };
  }
  if (!second) return { exitCode: first.code, retry: true, ...none };
  if (second.code === 0) {
    return { exitCode: 0, retry: true, flaky: [...new Set(first.failures.map((f) => f.id))], quarantined: [] };
  }
  const failed = { exitCode: second.code ?? 1, retry: true, ...none };
  if (second.code === null || second.buildFailed || second.raceDetected || second.unattributed || first.unattributed) return failed;
  if (changedFiles === null || quarantine.size === 0 || second.failures.length === 0) return failed;
  const blocking = second.failures.filter((f) => !isQuarantined(f, quarantine) || failureTouched(f, changedFiles, paths));
  if (blocking.length) return failed;
  const secondIds = new Set(second.failures.map((f) => f.id));
  return {
    exitCode: 0,
    retry: true,
    flaky: [...new Set(first.failures.map((f) => f.id))].filter((id) => !secondIds.has(id)),
    quarantined: [...secondIds],
  };
}

// ── Ledger context ───────────────────────────────────────────────────────

// The ledger runner for a wrapped step: vitest by its label's job prefix
// (`api-3` → vitest-api), go always `go`. Unknown → null → nothing quarantined.
const VITEST_LABELS = { api: 'vitest-api', web: 'vitest-web', integration: 'vitest-integration' };

export function ledgerRunner(runner, label) {
  if (runner === 'go') return 'go';
  if (runner !== 'vitest') return null;
  const m = /^([a-z]+)-/.exec(label);
  return (m && VITEST_LABELS[m[1]]) || null;
}

// Repo-relative path mapping for failureTouched: vitest files are relative to
// the package (vitest-api/-integration run in apps/api, vitest-web in
// apps/web); go packages map through the module path in <go-dir>/go.mod.
function ledgerPaths(ledger, { repoRoot, goDir }) {
  if (ledger === 'vitest-api') return { prefix: 'apps/api/' };
  // An integration test exercises far beyond its sibling: without a declared
  // `covers`, any non-test change under apps/api/src/ touches it.
  if (ledger === 'vitest-integration') return { prefix: 'apps/api/', sourceRoot: 'apps/api/src/' };
  if (ledger === 'vitest-web') return { prefix: 'apps/web/' };
  if (ledger !== 'go') return null;
  try {
    const mod = /^module\s+(\S+)/m.exec(readFileSync(join(goDir, 'go.mod'), 'utf8'));
    const dir = relative(repoRoot, goDir).split('\\').join('/');
    if (!mod || dir.startsWith('..')) return null;
    return { goModule: mod[1], goDir: dir };
  } catch {
    return null;
  }
}

function quarantineContext({ runner, label, goDir }) {
  const none = { quarantine: new Set(), changedFiles: null, paths: {} };
  const ledger = ledgerRunner(runner, label);
  const baseSha = process.env.CI_BASE_SHA ?? '';
  if (!ledger || !baseSha) return none;
  const repoRoot = process.cwd();
  const paths = ledgerPaths(ledger, { repoRoot, goDir });
  if (!paths) return none;
  const today = new Date().toISOString().slice(0, 10);
  const active = activeEntries(loadBaseLedger({ baseSha, repoRoot }), ledger, today);
  if (active.length === 0) return none;
  const quarantine = new Set(active.map((e) => e.id));
  paths.covers = new Map(active.filter((e) => e.covers).map((e) => [e.id, e.covers]));
  const changed = changedFiles({ baseSha, repoRoot });
  if (changed === null) {
    process.stdout.write(`::notice title=Quarantine disabled::${escapeData(`${label}: cannot diff ${baseSha}..HEAD, so no test is quarantined`)}\n`);
  }
  return { quarantine, changedFiles: changed, paths };
}

// ── Go command rewriting + coverage merge ────────────────────────────────

// `go test` / build flags that take a separate value when written without `=`.
const GO_VALUE_FLAGS = new Set([
  'C', 'asmflags', 'bench', 'benchtime', 'blockprofile', 'blockprofilerate', 'compiler', 'count',
  'covermode', 'coverpkg', 'coverprofile', 'cpu', 'cpuprofile', 'exec', 'fuzz', 'fuzzminimizetime',
  'fuzztime', 'gccgoflags', 'gcflags', 'installsuffix', 'ldflags', 'list', 'memprofile',
  'memprofilerate', 'mod', 'modfile', 'mutexprofile', 'mutexprofilefraction', 'o', 'outputdir',
  'overlay', 'p', 'parallel', 'pgo', 'pkgdir', 'run', 'shuffle', 'skip', 'tags', 'timeout',
  'toolexec', 'trace', 'vet',
]);

// `args` are the arguments after `go` (starting with `test`). Returns the
// same flags with the package patterns replaced by `pkgs` and any
// -coverprofile pointed at `<file>.retry`.
export function goRetryArgs(args, pkgs) {
  const out = [args[0]];
  let coverProfile = null;
  let placed = false;
  const place = () => {
    if (!placed) out.push(...pkgs);
    placed = true;
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-args' || a === '--args') {
      place();
      out.push(...args.slice(i));
      return { args: out, coverProfile };
    }
    if (!a.startsWith('-')) {
      place(); // a package pattern
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.replace(/^--?/, '').split('=')[0];
    if (eq !== -1) {
      if (name === 'coverprofile') {
        coverProfile = a.slice(eq + 1);
        out.push(`${a.slice(0, eq)}=${coverProfile}.retry`);
      } else {
        out.push(a);
      }
    } else if (GO_VALUE_FLAGS.has(name) && i + 1 < args.length) {
      const value = args[++i];
      if (name === 'coverprofile') coverProfile = value;
      out.push(a, name === 'coverprofile' ? `${value}.retry` : value);
    } else {
      out.push(a);
    }
  }
  place();
  return { args: out, coverProfile };
}

const COVER_LINE = /^(.+):\d+\.\d+,\d+\.\d+ \d+ \d+$/;
const coverPkg = (line) => {
  const m = COVER_LINE.exec(line);
  if (!m) return null;
  return m[1].slice(0, m[1].lastIndexOf('/'));
};

// Replace the retried packages' blocks in `base` with `retry`'s.
export function mergeCoverProfiles(base, retry) {
  const split = (text) => text.split('\n').filter((l) => l.trim() !== '');
  const baseLines = split(base);
  const retryLines = split(retry);
  const mode = baseLines.find((l) => l.startsWith('mode:')) ?? retryLines.find((l) => l.startsWith('mode:')) ?? 'mode: set';
  const retryBlocks = retryLines.filter((l) => !l.startsWith('mode:'));
  const retried = new Set(retryBlocks.map(coverPkg).filter(Boolean));
  const kept = baseLines.filter((l) => !l.startsWith('mode:') && !retried.has(coverPkg(l)));
  return [mode, ...kept, ...retryBlocks].join('\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseCli(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1) throw new UsageError('missing `--` before the command');
  const opts = { runner: null, label: null, goDir: '.' };
  const flags = argv.slice(0, sep);
  for (let i = 0; i < flags.length; i++) {
    const [k, v] = [flags[i], flags[i + 1]];
    if (k === '--runner') opts.runner = v;
    else if (k === '--label') opts.label = v;
    else if (k === '--go-dir') opts.goDir = v;
    else throw new UsageError(`unknown option ${k}`);
    if (v === undefined) throw new UsageError(`${k} needs a value`);
    i++;
  }
  const command = argv.slice(sep + 1);
  if (!['vitest', 'go'].includes(opts.runner)) throw new UsageError('--runner must be vitest or go');
  if (!opts.label || !/^[A-Za-z0-9._-]+$/.test(opts.label)) throw new UsageError('--label is required ([A-Za-z0-9._-])');
  if (command.length === 0) throw new UsageError('no command after `--`');
  if (opts.runner === 'go' && (basename(command[0]) !== 'go' || command[1] !== 'test')) {
    throw new UsageError('the go runner wraps `go test ...` only');
  }
  return { ...opts, command };
}

// Runs one attempt with stdin inherited, teeing stdout/stderr to temp files.
// For go, stdout is `-json` events: each event's Output is re-printed so the
// log reads like plain `go test -v`.
function runAttempt(command, { cwd, runner }) {
  return new Promise((done) => {
    const dir = mkdtempSync(join(tmpdir(), 'retry-shard-'));
    const outPath = join(dir, 'stdout');
    const errPath = join(dir, 'stderr');
    const out = createWriteStream(outPath);
    const err = createWriteStream(errPath);
    let interrupted = false;
    let pending = '';
    // `go test -json` interleaves events from packages running in parallel;
    // plain `go test` prints each package's output as one block when it ends.
    // Buffer per package and flush on the package's final event to match.
    const buffers = new Map();
    const flush = (pkg) => {
      const buf = buffers.get(pkg);
      if (buf) process.stdout.write(buf.join(''));
      buffers.delete(pkg);
    };
    const printGoLine = (line) => {
      if (line.startsWith('{')) {
        let ev = null;
        try {
          ev = JSON.parse(line);
        } catch {
          // not an event — print as-is below
        }
        if (ev) {
          if (typeof ev.Output === 'string') {
            if (ev.Package) {
              if (!buffers.has(ev.Package)) buffers.set(ev.Package, []);
              buffers.get(ev.Package).push(ev.Output);
            } else {
              process.stdout.write(ev.Output);
            }
          }
          if (ev.Package && !ev.Test && ['pass', 'fail', 'skip'].includes(ev.Action)) flush(ev.Package);
          return;
        }
      }
      process.stdout.write(`${line}\n`);
    };

    const child = spawn(command[0], command.slice(1), { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    const forward = (sig) => {
      interrupted = true;
      child.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.stdout.on('data', (chunk) => {
      out.write(chunk);
      if (runner !== 'go') {
        process.stdout.write(chunk);
        return;
      }
      const lines = (pending + chunk.toString('utf8')).split('\n');
      pending = lines.pop();
      for (const l of lines) printGoLine(l);
    });
    child.stderr.on('data', (chunk) => {
      err.write(chunk);
      process.stderr.write(chunk);
    });

    let spawnError = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (pending) printGoLine(pending);
      for (const pkg of [...buffers.keys()]) flush(pkg);
      if (spawnError) process.stderr.write(`retry-shard: cannot run ${command[0]}: ${spawnError.message}\n`);
      let closed = 0;
      const finish = () => {
        if (++closed < 2) return;
        const output = `${readFileSync(outPath, 'utf8')}\n${readFileSync(errPath, 'utf8')}`;
        rmSync(dir, { recursive: true, force: true });
        const exit = spawnError ? 127 : signal || interrupted ? null : code;
        done({ code: exit, output });
      };
      out.end(finish);
      err.end(finish);
    });
  });
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function writeReport({ label, attempts, verdict, firstFailures }) {
  const report = { label, attempts, flaky: verdict.flaky, quarantined: verdict.quarantined, exitCode: verdict.exitCode };
  writeFileSync(`flake-report-${label}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const code = (id) => `\`${id.replace(/`/g, "'")}\``;
  const lines = [
    `### Test retry: ${label}`,
    '',
    '| Label | Attempts | Exit | Flaky | Quarantined |',
    '| --- | --- | --- | --- | --- |',
    `| ${label} | ${attempts} | ${verdict.exitCode} | ${verdict.flaky.length} | ${verdict.quarantined.length} |`,
    '',
  ];
  if (verdict.flaky.length) lines.push('Failed, then passed on retry:', '', ...verdict.flaky.map((id) => `- ${code(id)}`), '');
  if (verdict.quarantined.length) lines.push('Quarantined:', '', ...verdict.quarantined.map((id) => `- ${code(id)}`), '');
  if (!verdict.flaky.length && firstFailures.length) {
    lines.push('Failed on attempt 1:', '', ...firstFailures.slice(0, 50).map((f) => `- ${code(f.id)}`), '');
  }
  appendFileSync(summary, `${lines.join('\n')}\n`);
}

async function main(argv) {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`retry-shard: ${e.message}\nusage: retry-shard.mjs --runner vitest|go --label <name> [--go-dir <dir>] -- <command...>\n`);
    return 2;
  }
  const { runner, label } = opts;
  let command = opts.command;
  const cwd = runner === 'go' ? resolve(opts.goDir) : process.cwd();
  if (runner === 'go' && !command.includes('-json')) command = [command[0], 'test', '-json', ...command.slice(2)];

  const first = await runAttempt(command, { cwd, runner });
  const p1 = parseFailures(runner, first.output);
  const firstResult = { code: first.code, ...p1 };
  if (p1.raceDetected && first.code !== 0) {
    process.stdout.write(
      `::error title=Data race::${escapeData(`${label}: the race detector reported a data race; not retrying (a clean re-run would hide it)`)}\n`,
    );
  }
  let verdict = decide({ first: firstResult, second: null });
  let attempts = 1;

  if (verdict.retry) {
    let retryCommand = command;
    let coverProfile = null;
    let scope = 'the whole shard';
    if (runner === 'go') {
      const pkgs = [...new Set(p1.failures.map((f) => f.pkg))];
      const r = goRetryArgs(command.slice(1), pkgs);
      retryCommand = [command[0], ...r.args];
      coverProfile = r.coverProfile;
      scope = `package(s) ${pkgs.join(' ')}`;
    }
    const n = p1.failures.length;
    process.stdout.write(
      `::warning title=Retrying test shard::${escapeData(`${label}: attempt 1 failed with ${n} failing test(s); re-running ${scope} once`)}\n`,
    );
    const second = await runAttempt(retryCommand, { cwd, runner });
    attempts = 2;
    const p2 = parseFailures(runner, second.output);
    const secondResult = { code: second.code, ...p2 };
    // The ledger is consulted only when the second attempt failed too.
    const ctx = second.code === 0 ? {} : quarantineContext({ runner, label, goDir: cwd });
    verdict = decide({ first: firstResult, second: secondResult, ...ctx });
    if (coverProfile) {
      const basePath = resolve(cwd, coverProfile);
      const retryPath = `${basePath}.retry`;
      if (existsSync(retryPath)) {
        const baseText = existsSync(basePath) ? readFileSync(basePath, 'utf8') : '';
        writeFileSync(basePath, mergeCoverProfiles(baseText, readFileSync(retryPath, 'utf8')));
        unlinkSync(retryPath);
      }
    }
  }

  if (first.code !== 0) writeReport({ label, attempts, verdict, firstFailures: p1.failures });
  for (const id of verdict.flaky) process.stdout.write(`::warning title=Flaky test::${escapeData(id)}\n`);
  for (const id of verdict.quarantined) process.stdout.write(`::warning title=Quarantined test::${escapeData(id)}\n`);
  return verdict.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
