import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Scaling W07 (#8146): the perf gate runs on a SELF-HOSTED runner (`breeze-perf`)
 * in a PUBLIC repository. A `pull_request` trigger would let any fork run code on
 * that machine, so the trigger set, the runner label, the repository guard, the
 * permissions and the action pins are all load-bearing. `apps/api` has no YAML
 * parser, so the workflows are read as text with line-anchored regexes; that is
 * why permissions must be written in block style.
 *
 * `perf-rules.yml` is the GitHub-hosted, PR-triggered, non-blocking half
 * (promtool + comparator tests). Neither workflow may be wired into `ci.yml`'s
 * `ci-success`.
 */
const wf = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8');

/** Lines of a top-level key's block (`^key:` to the next column-0 line). */
function topBlock(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^${key}:[^\\n]*\\n((?:(?:[ \\t]+[^\\n]*)?\\n)*)`, 'm'));
  return m ? m[0] : null;
}

/** `{ jobId: blockText }` for every job under `jobs:`. */
function jobs(text: string): Record<string, string> {
  const block = topBlock(text, 'jobs');
  expect(block, 'jobs: block').not.toBeNull();
  const out: Record<string, string> = {};
  const parts = block!.split(/^ {2}([A-Za-z0-9_-]+):\s*$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

function jobField(job: string, key: string): string | undefined {
  return job.match(new RegExp(`^ {4}${key}:\\s*(.*)$`, 'm'))?.[1]?.trim();
}

/** Steps of a job, split on `      - `. */
function steps(job: string): string[] {
  return job.split(/^ {6}- /m).slice(1);
}

function expectBlockStylePermissions(text: string, where: string): void {
  for (const m of text.matchAll(/^(\s*)permissions:(.*)$/gm)) {
    expect(m[2]!.trim(), `${where}: permissions must be block style (one key per line), not "${m[2]!.trim()}"`).toBe('');
  }
}

function expectPinnedActions(text: string, where: string): void {
  const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.*)$/gm)].map((m) => m[1]!.trim());
  expect(uses.length, `${where} uses at least one action`).toBeGreaterThan(0);
  for (const u of uses) {
    expect(u, `${where}: "${u}" must be pinned to a 40-hex SHA with a # vX comment`).toMatch(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40} # v\S+$/,
    );
  }
}

describe('perf.yml — self-hosted perf gate (#8146)', () => {
  const text = wf('perf.yml');
  const all = jobs(text);

  it('triggers only on schedule and workflow_dispatch', () => {
    const on = topBlock(text, 'on');
    expect(on, 'on: block').not.toBeNull();
    const keys = [...on!.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(text).not.toMatch(/^\s*(pull_request|pull_request_target|push|workflow_run|issue_comment)\s*:/m);
  });

  it('runs breeze-perf jobs only behind the repository guard, and the schedule only behind PERF_NIGHTLY_ENABLED', () => {
    const selfHosted = Object.entries(all).filter(([, j]) => /self-hosted|breeze-perf/.test(jobField(j, 'runs-on') ?? ''));
    expect(selfHosted.length).toBeGreaterThan(0);
    for (const [id, j] of selfHosted) {
      expect(jobField(j, 'runs-on'), `${id} runs-on`).toBe('[self-hosted, breeze-perf]');
      const cond = jobField(j, 'if') ?? '';
      expect(cond, `${id} if:`).toContain("github.repository == 'LanternOps/breeze'");
      expect(cond, `${id} if:`).toContain("vars.PERF_NIGHTLY_ENABLED == 'true'");
      expect(cond, `${id} if:`).toContain("github.event_name == 'workflow_dispatch'");
    }
  });

  it('grants contents: read at the top, and issues: write only to a GitHub-hosted notifier', () => {
    expectBlockStylePermissions(text, 'perf.yml');
    expect(topBlock(text, 'permissions')!.trim()).toBe('permissions:\n  contents: read');
    const writers = Object.entries(all).filter(([, j]) => /^ {6}issues: write$/m.test(j));
    expect(writers.map(([id]) => id)).toEqual(['notify']);
    const notify = all.notify!;
    expect(jobField(notify, 'runs-on')).toBe('ubuntu-latest');
    expect(jobField(notify, 'if')).toContain("github.event_name == 'schedule'");
    expect(jobField(notify, 'if')).toContain("github.repository == 'LanternOps/breeze'");
    for (const [id, j] of Object.entries(all)) {
      const perms = j.match(/^ {4}permissions:\n((?: {6}.*\n)*)/m)?.[1] ?? '';
      for (const line of perms.split('\n').filter(Boolean)) {
        expect(['      contents: read', '      issues: write'], `${id} permission "${line.trim()}"`).toContain(line);
      }
      expect(j, `${id} must not use write-all/read-all`).not.toMatch(/(write|read)-all/);
    }
  });

  it('pins every action to a SHA', () => {
    expectPinnedActions(text, 'perf.yml');
  });

  it('bounds every job and never cancels a run in progress', () => {
    for (const [id, j] of Object.entries(all)) {
      const t = Number(jobField(j, 'timeout-minutes'));
      expect(t, `${id} timeout-minutes`).toBeGreaterThan(0);
      expect(t, `${id} timeout-minutes`).toBeLessThanOrEqual(120);
    }
    expect(topBlock(text, 'concurrency')).toMatch(/^concurrency:\n {2}group: \S+\n {2}cancel-in-progress: false\n/);
  });

  it('uses no repository secrets', () => {
    expect(text).not.toMatch(/secrets\./);
  });

  it('applies the slowdown patch only on a workflow_dispatch with inject=slow-heartbeat', () => {
    const on = topBlock(text, 'on')!;
    const inject = on.match(/^ {6}inject:\n((?: {8}.*\n)*)/m)?.[1];
    expect(inject, 'workflow_dispatch input inject').toBeDefined();
    expect(inject).toMatch(/^ {8}type: choice$/m);
    expect(inject).toMatch(/^ {8}options: \[none, slow-heartbeat\]$/m);
    expect(inject).toMatch(/^ {8}default: none$/m);

    const patchSteps = Object.values(all).flatMap(steps).filter((s) => s.includes('inject/slow-heartbeat.patch'));
    expect(patchSteps.length).toBeGreaterThan(0);
    for (const s of patchSteps) {
      const cond = s.match(/^ {8}if:\s*(.*)$/m)?.[1] ?? '';
      expect(cond, 'patch step if:').toContain("inputs.inject == 'slow-heartbeat'");
      expect(cond, 'patch step if:').toContain("github.event_name == 'workflow_dispatch'");
    }
  });

  it('uploads load-tests/perf/out/** on always()', () => {
    const upload = Object.values(all).flatMap(steps).find((s) => /uses: actions\/upload-artifact@/.test(s));
    expect(upload, 'upload-artifact step').toBeDefined();
    expect(upload).toMatch(/^ {8}if: always\(\)$/m);
    expect(upload).toMatch(/^ {10}path: load-tests\/perf\/out\/\*\*$/m);
  });
});

describe('perf-rules.yml — PR-triggered rules + comparator check (#8146)', () => {
  const text = wf('perf-rules.yml');

  it('runs on pull_request, path-filtered to the rules, dashboards and perf tooling', () => {
    const on = topBlock(text, 'on')!;
    expect([...on.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1])).toEqual(['pull_request']);
    const paths = [...on.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]).sort();
    expect(paths).toEqual([
      '.github/workflows/perf-rules.yml',
      'load-tests/perf/**',
      'monitoring/grafana/dashboards/**',
      'monitoring/rules/**',
    ]);
    expect(text).not.toMatch(/pull_request_target/);
  });

  it('never runs on a self-hosted runner and only reads the repo', () => {
    for (const [id, j] of Object.entries(jobs(text))) {
      expect(jobField(j, 'runs-on'), `${id} runs-on`).toBe('ubuntu-latest');
      expect(Number(jobField(j, 'timeout-minutes')), `${id} timeout`).toBeGreaterThan(0);
    }
    expect(text).not.toMatch(/self-hosted|breeze-perf/);
    expectBlockStylePermissions(text, 'perf-rules.yml');
    expect(topBlock(text, 'permissions')!.trim()).toBe('permissions:\n  contents: read');
    expect(text).not.toMatch(/^ {4}permissions:/m);
    expect(text).not.toMatch(/secrets\./);
  });

  it('pins every action to a SHA', () => {
    expectPinnedActions(text, 'perf-rules.yml');
  });

  it('actually runs the rule unit tests and the comparator tests', () => {
    // Deleting either step would leave every suite green while the recording-rule
    // arithmetic and the 15 % gate stop being tested anywhere in CI.
    expect(text).toMatch(/prom\/prometheus:v\d+\.\d+\.\d+ check rules \/rules\/breeze-rules\.yml/);
    expect(text).toMatch(/prom\/prometheus:v\d+\.\d+\.\d+ test rules \/rules\/tests\/breeze-capacity-kpis\.test\.yml/);
    expect(text).toMatch(/^\s+run: node --test perf\/\*\.test\.mjs$/m);
  });
});

describe('ci.yml stays out of the perf gate', () => {
  it('no ci.yml job references perf.yml, the breeze-perf runner or load-tests/perf', () => {
    const ci = wf('ci.yml');
    expect(ci).not.toMatch(/perf\.yml|perf-rules\.yml|breeze-perf|load-tests\/perf/);
  });
});
