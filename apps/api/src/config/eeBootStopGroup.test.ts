import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/ci/stop-ee-boot-group.sh is the teardown half of the "Boot API once to
// apply built-in extension migrations (ee)" step in .github/workflows/ci.yml.
// These tests drive it as real bash, with `kill`/`ps`/`sleep` shadowed by shell
// functions where the real syscall cannot be provoked on demand (EPERM needs a
// process owned by another user), and with genuine process groups where it can.
const scriptPath = fileURLToPath(new URL('../../../../scripts/ci/stop-ee-boot-group.sh', import.meta.url));
const workflowPath = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url));

const PGID = 4242;
const FATAL = '\\[CRITICAL\\] API startup failed';

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

interface HarnessResult {
  status: number;
  output: string;
}

/**
 * Source the script into a bash shell, apply `stubs`, then run `body` (whose
 * last command must be the `stop_ee_boot_group` call under test).
 */
function runHarness(stubs: string, body: string, logContents = 'loaded built-in "workspace"\n'): HarnessResult {
  const root = mkdtempSync(join(tmpdir(), 'ee-boot-stop-'));
  tempRoots.push(root);
  const logPath = join(root, 'boot.log');
  writeFileSync(logPath, logContents);

  const harness = [
    'set -uo pipefail',
    `source ${JSON.stringify(scriptPath)}`,
    `LOG=${JSON.stringify(logPath)}`,
    `FATAL=${JSON.stringify(FATAL)}`,
    stubs,
    body,
    'exit $?',
  ].join('\n');

  const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 60_000 });
  if (run.error) throw run.error;
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/** Run the script the way ci.yml does — as a subprocess, not sourced. */
function runScript(body: string, logContents = 'loaded built-in "workspace"\n'): HarnessResult {
  const root = mkdtempSync(join(tmpdir(), 'ee-boot-stop-'));
  tempRoots.push(root);
  const logPath = join(root, 'boot.log');
  writeFileSync(logPath, logContents);

  const harness = [
    'set -uo pipefail',
    `SCRIPT=${JSON.stringify(scriptPath)}`,
    `LOG=${JSON.stringify(logPath)}`,
    `FATAL=${JSON.stringify(FATAL)}`,
    body,
    'exit $?',
  ].join('\n');

  const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 60_000 });
  if (run.error) throw run.error;
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/** `kill` that fails the way the bash builtin does for the given errno. */
function killFailing(strerror: string): string {
  return `kill() { echo "bash: line 1: kill: ($1) - ${strerror}" >&2; return 1; }`;
}

/**
 * `ps` reporting `stats` (process STAT codes) as the members of PGID. Serves
 * both call shapes the script uses: `-eo pgid=,stat=` for the liveness count
 * and `-eo pid,pgid,stat,cmd` for the failure dump.
 */
function psReporting(stats: string[]): string {
  const quote = (lines: string[]): string => (lines.length ? lines.map((l) => `"${l}"`).join(' ') : '""');
  const short = quote(stats.map((stat) => `${PGID} ${stat}`));
  const long = quote(stats.map((stat, i) => `${9000 + i} ${PGID} ${stat} node`));
  return `ps() { case "$*" in *'pgid=,stat='*) printf '%s\\n' ${short} ;; *) printf '%s\\n' ${long} ;; esac; }`;
}

const NO_SLEEP = 'sleep() { :; }';
const CALL = `stop_ee_boot_group ${PGID} "$LOG" "$FATAL"`;

describe('stop-ee-boot-group.sh kill error handling (#3471)', () => {
  it('fails loudly and names the PGID when the group exists but is not signalable (EPERM)', () => {
    const { status, output } = runHarness(
      [killFailing('Operation not permitted'), psReporting(['S']), NO_SLEEP].join('\n'),
      CALL,
    );

    // EPERM means a live, unsignalable API that will keep writing to this
    // shard's DB — it must fail the step, not be waved through.
    expect(status).toBe(1);
    expect(output).toContain(String(PGID));
    expect(output).toMatch(/not permitted|permission|EPERM/i);
    // ...and it must NOT be reported as the benign "it already exited" case.
    expect(output).not.toMatch(/::warning::/);
    expect(output).not.toMatch(/already exited/i);
  });

  // The EPERM guard is an OR of two deliberately independent signals: the
  // process table (ground truth) and a match on kill's stderr (a fallback for
  // hosts where `ps` is blind). The test above has BOTH true, so it cannot tell
  // which one fired — dropping either operand would still leave it green. These
  // two isolate the operands, one each.
  it('fails loudly on ps-visible survivors even when the errno text is unrecognised', () => {
    const { status, output } = runHarness(
      // Some other errno entirely: only the process-table check can catch this.
      [killFailing('Invalid argument'), psReporting(['S']), NO_SLEEP].join('\n'),
      CALL,
    );

    expect(status).toBe(1);
    expect(output).toMatch(/Could not signal API process group 4242/);
    expect(output).not.toMatch(/::warning::/);
    expect(output).not.toMatch(/already exited/i);
  });

  it('fails loudly on EPERM even where ps cannot see the group (hidepid / PID namespace)', () => {
    const { status, output } = runHarness(
      // `ps` reports nothing, so only the stderr text match can catch this —
      // the exact host on which the old code passed with a live API running.
      [killFailing('Operation not permitted'), psReporting([]), NO_SLEEP].join('\n'),
      CALL,
    );

    expect(status).toBe(1);
    expect(output).toMatch(/Could not signal API process group 4242/);
    expect(output).not.toMatch(/::warning::/);
    expect(output).not.toMatch(/already exited/i);
  });

  it('treats a group that is genuinely gone (ESRCH) as benign and continues', () => {
    const { status, output } = runHarness(
      [killFailing('No such process'), psReporting([]), NO_SLEEP].join('\n'),
      CALL,
    );

    expect(status).toBe(0);
    expect(output).toMatch(/::warning::/);
    expect(output).toMatch(/already exited/i);
    // The benign branch must not borrow the EPERM wording.
    expect(output).not.toMatch(/not permitted/i);
  });

  it('still fails when an already-exited group also logged the fatal startup sentinel', () => {
    const { status, output } = runHarness(
      [killFailing('No such process'), psReporting([]), NO_SLEEP].join('\n'),
      CALL,
      'loaded built-in "workspace"\n[CRITICAL] API startup failed\n',
    );

    expect(status).toBe(1);
    expect(output).toMatch(/FAILED startup/);
    expect(output).not.toMatch(/::warning::/);
  });

  it('fails closed when the signals land but the group survives them', () => {
    const { status, output } = runHarness(
      ['kill() { return 0; }', psReporting(['S']), NO_SLEEP].join('\n'),
      CALL,
    );

    expect(status).toBe(1);
    expect(output).toMatch(/survived SIGTERM and SIGKILL/);
  });

  it('succeeds quietly when the kill lands and the group goes away', () => {
    const { status, output } = runHarness(
      ['kill() { return 0; }', psReporting([]), NO_SLEEP].join('\n'),
      CALL,
    );

    expect(status).toBe(0);
    expect(output).not.toMatch(/::warning::/);
    expect(output).not.toMatch(/survived/);
  });

  it('treats a zombie-only group as gone rather than as a survivor', () => {
    const { status, output } = runHarness(
      ['kill() { return 0; }', psReporting(['Z', 'Z']), NO_SLEEP].join('\n'),
      CALL,
    );

    expect(status).toBe(0);
    expect(output).not.toMatch(/survived/);
  });
});

describe('stop-ee-boot-group.sh against real process groups', () => {
  // `set -m` gives the background job its own process group without needing
  // `setsid` (absent on macOS), so `$!` is both the leader PID and the PGID.
  it('kills a live process group and reports success', () => {
    const { status, output } = runHarness(
      '',
      [
        'set -m',
        'sleep 45 &',
        'REAL_PGID=$!',
        'set +m',
        'stop_ee_boot_group "$REAL_PGID" "$LOG" "$FATAL"',
      ].join('\n'),
    );

    expect(status).toBe(0);
    expect(output).not.toMatch(/survived SIGTERM and SIGKILL/);
    expect(output).not.toMatch(/not permitted/i);
  });

  it('takes the benign ESRCH path for a group that already exited', () => {
    const { status, output } = runHarness(
      '',
      [
        'set -m',
        'sleep 45 &',
        'REAL_PGID=$!',
        'set +m',
        // Kill and fully reap it first, so the script's own kill hits a group
        // that no longer exists — the real ESRCH the benign branch is for.
        'kill -9 -- "-$REAL_PGID" 2>/dev/null || true',
        'wait "$REAL_PGID" 2>/dev/null || true',
        'stop_ee_boot_group "$REAL_PGID" "$LOG" "$FATAL"',
      ].join('\n'),
    );

    expect(status).toBe(0);
    expect(output).toMatch(/::warning::/);
    expect(output).not.toMatch(/not permitted/i);
  });
});

// The tests above source the script and call the function directly. These run
// the real entrypoint the way ci.yml does — `bash scripts/ci/stop-ee-boot-group.sh
// <pgid> <log> <fatal>` — so the argument passing and the `set -euo pipefail`
// guard are covered too, not just the function body.
describe('stop-ee-boot-group.sh as a subprocess (the ci.yml entrypoint)', () => {
  it('kills a real group and exits 0 when invoked with the ci.yml argument shape', () => {
    const { status, output } = runScript(
      [
        'set -m',
        'sleep 45 &',
        'REAL_PGID=$!',
        'set +m',
        'bash "$SCRIPT" "$REAL_PGID" "$LOG" "$FATAL"',
        'rc=$?',
        // Non-zombie members left in the group, counted without awk quoting.
        'SURVIVORS=$(ps -eo pgid=,stat= | grep -c "^ *$REAL_PGID [^Z]" || true)',
        'echo "survivors=$SURVIVORS"',
        'exit $rc',
      ].join('\n'),
    );

    expect(status).toBe(0);
    expect(output).toMatch(/survivors=0/);
  });

  it('propagates a genuine failure as a non-zero exit that aborts a `bash -e` caller', () => {
    // GitHub Actions runs `run:` blocks under `bash -eo pipefail`, so the step
    // must abort on the script's exit 1 rather than running the next line.
    // Driven through the fatal-sentinel path: a group that really has exited
    // (ESRCH) whose log also recorded a startup failure. Deterministic, and it
    // needs no signal sent to anything we do not own.
    const { status, output } = runScript(
      [
        'set -m',
        'sleep 45 &',
        'REAL_PGID=$!',
        'set +m',
        'kill -9 -- "-$REAL_PGID" 2>/dev/null || true',
        'wait "$REAL_PGID" 2>/dev/null || true',
        'set -e',
        'bash "$SCRIPT" "$REAL_PGID" "$LOG" "$FATAL"',
        'echo "REACHED-NEXT-LINE"',
      ].join('\n'),
      'loaded built-in "workspace"\n[CRITICAL] API startup failed\n',
    );

    expect(status).toBe(1);
    expect(output).toMatch(/FAILED startup/);
    expect(output).not.toMatch(/REACHED-NEXT-LINE/);
  });

  it('rejects a wrong argument count with a usage message and exit 2', () => {
    const { status, output } = runScript('bash "$SCRIPT" 4242');

    expect(status).toBe(2);
    expect(output).toMatch(/usage: stop-ee-boot-group\.sh/);
  });
});

describe('ci.yml wiring', () => {
  it('has the ee boot step delegate its teardown to the script', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const stepStart = workflow.indexOf('- name: Boot API once to apply built-in extension migrations (ee)');
    expect(stepStart).toBeGreaterThan(-1);
    const step = workflow.slice(stepStart, workflow.indexOf('      - name:', stepStart + 1));

    expect(step).toContain('scripts/ci/stop-ee-boot-group.sh');
    // The teardown must not drift back inline, where the ESRCH/EPERM branches
    // would again be untestable.
    expect(step).not.toMatch(/survived SIGTERM and SIGKILL/);
  });
});
