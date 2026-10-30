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
// When the first attempt fails it writes flake-report-<label>.json
// ({label, attempts, flaky, quarantined, exitCode}) in the working directory,
// appends a table to $GITHUB_STEP_SUMMARY and prints a `::warning` per flaky
// test. The exit code is decide().exitCode.

import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function parseVitest(output) {
  const failures = [];
  const seen = new Set();
  let inSummary = false;
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '').replace(/\r$/, '');
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
  return { failures, buildFailed: false, raceDetected: false };
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

function parseGo(output) {
  const fails = [];
  let buildFailed = false;
  let raceDetected = false;
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
    if (ev.Action !== 'fail' || !ev.Package) continue;
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
  return { failures, buildFailed, raceDetected };
}

export function parseFailures(runner, output) {
  if (runner === 'vitest') return parseVitest(output);
  if (runner === 'go') return parseGo(output);
  throw new Error(`unknown runner: ${runner}`);
}

// ── Decision ─────────────────────────────────────────────────────────────

// Pure: called with `second: null` to ask whether to retry, then again with
// the second attempt's result for the final verdict. `quarantine` and
// `changedFiles` feed the Task 3 rule (a quarantined test whose file the PR
// did not touch may fail twice); in this wave quarantine is always empty.
export function decide({ first, second, quarantine, changedFiles }) {
  const none = { flaky: [], quarantined: [] };
  if (first.code === 0) return { exitCode: 0, retry: false, ...none };
  if (first.code === null || first.buildFailed || first.raceDetected || first.failures.length === 0) {
    return { exitCode: first.code ?? 1, retry: false, ...none };
  }
  if (!second) return { exitCode: first.code, retry: true, ...none };
  if (second.code === 0) {
    return { exitCode: 0, retry: true, flaky: [...new Set(first.failures.map((f) => f.id))], quarantined: [] };
  }
  void quarantine;
  void changedFiles;
  return { exitCode: second.code ?? 1, retry: true, ...none };
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
  const firstResult = { code: first.code, failures: p1.failures, buildFailed: p1.buildFailed, raceDetected: p1.raceDetected };
  if (p1.raceDetected && first.code !== 0) {
    process.stdout.write(
      `::error title=Data race::${escapeData(`${label}: the race detector reported a data race; not retrying (a clean re-run would hide it)`)}\n`,
    );
  }
  const ctx = { quarantine: new Set(), changedFiles: null };
  let verdict = decide({ first: firstResult, second: null, ...ctx });
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
    verdict = decide({ first: firstResult, second: { code: second.code, failures: p2.failures }, ...ctx });
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
  return verdict.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
