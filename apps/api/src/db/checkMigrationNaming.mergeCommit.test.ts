import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// scripts/check-migration-naming.sh on merge commits, cherry-picks and renames
// of shipped migrations (#10015).
//
// Merging origin/main into a branch stages main's newer migrations as
// ADDITIONS relative to HEAD. The pre-commit guard judged them as if the
// branch had authored them, and when main itself carried an out-of-order pair
// (2027-01-04-100300 committed after 2027-01-04-110000) it reported main's own
// file as a violation. The only "fix" a fixer could see was renaming a file —
// and #9997 renamed the SHIPPED 2027-01-04-110000-ticket-merge.sql, which
// would have orphaned its breeze_migrations ledger row.
//
// These cases drive the real script against a real temporary repo with a bare
// "origin" remote, because the behaviour under test is git state (MERGE_HEAD,
// origin/main, staged deletions), not filenames alone.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts/check-migration-naming.sh');

// Isolate the temp repos from the developer's global git config: a global
// core.hooksPath would run Breeze's own hooks inside the fixture, and a global
// commit.gpgsign would prompt.
const GIT_ISOLATION = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', [...GIT_ISOLATION, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} (cwd=${cwd}) failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result.stdout;
}

function runGuard(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, BREEZE_MIGRATIONS_DIR: 'migrations' };
  // A hook-invoked test run would otherwise point git at the outer repo.
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.BREEZE_MIGRATION_BASE_REF;
  delete env.BREEZE_ALLOW_MIGRATION_DELETE;
  Object.assign(env, extraEnv);
  const result = spawnSync('bash', [GUARD_SCRIPT, ...args], { cwd, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface Repo {
  dir: string;
  origin: string;
}

// Repo-relative fixture path. Built, not written as a literal: autoMigrate.test.ts
// fails on any `migrations/<date>-….sql` literal under src that does not exist
// in apps/api/migrations, and these fixture names deliberately do not.
function mig(name: string): string {
  return path.posix.join('migrations', name);
}

function addMigration(repo: Repo, name: string): void {
  writeFileSync(path.join(repo.dir, 'migrations', name), `-- ${name}\n`);
}

function commitAll(repo: Repo, message: string): void {
  git(['add', '-A'], repo.dir);
  git(['commit', '-m', message], repo.dir);
}

// On main: advance and push, then return to `feature` with origin/main fetched.
function advanceMain(repo: Repo, names: string[]): void {
  git(['checkout', 'main'], repo.dir);
  for (const name of names) {
    addMigration(repo, name);
    commitAll(repo, `main: ${name}`);
  }
  git(['push', 'origin', 'main'], repo.dir);
  git(['checkout', 'feature'], repo.dir);
  git(['fetch', 'origin', 'main'], repo.dir);
}

// base on origin/main, then a `feature` branch with its own migration.
function makeRepo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), 'migration-merge-work-'));
  const origin = mkdtempSync(path.join(tmpdir(), 'migration-merge-origin-'));
  git(['init', '--bare', '--initial-branch=main', origin], origin);
  git(['init', '--initial-branch=main', dir], dir);
  git(['config', 'user.email', 'guard-test@example.com'], dir);
  git(['config', 'user.name', 'Guard Test'], dir);
  git(['remote', 'add', 'origin', origin], dir);

  const repo = { dir, origin };
  mkdirSync(path.join(dir, 'migrations'));
  addMigration(repo, '2027-01-01-100000-base.sql');
  commitAll(repo, 'base');
  git(['push', 'origin', 'main'], dir);
  git(['fetch', 'origin', 'main'], dir);

  git(['checkout', '-b', 'feature'], dir);
  addMigration(repo, '2027-01-02-100000-feature.sql');
  commitAll(repo, 'feature migration');
  return repo;
}

function cleanup(repo: Repo): void {
  rmSync(repo.dir, { recursive: true, force: true });
  rmSync(repo.origin, { recursive: true, force: true });
}

// The #9995/#9996 shape: the branch already merged main once (so HEAD carries
// main's 110000), then main lands 100300 — an out-of-order pair ON MAIN — and
// the branch merges main again.
function mergeOutOfOrderMain(repo: Repo): void {
  advanceMain(repo, ['2027-01-04-110000-ticket-merge.sql']);
  git(['merge', '--no-ff', '--no-edit', 'origin/main'], repo.dir);
  advanceMain(repo, ['2027-01-04-100300-install-scripts.sql']);
  git(['merge', '--no-ff', '--no-commit', 'origin/main'], repo.dir);
}

describe('check-migration-naming on merge commits (#10015)', () => {
  it("passes a merge commit that brings in main's migrations, even main's own out-of-order pair", () => {
    const repo = makeRepo();
    try {
      mergeOutOfOrderMain(repo);
      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('VIOLATION');
    } finally {
      cleanup(repo);
    }
  });

  it('passes a merge even when origin/main is not fetched locally (MERGE_HEAD alone identifies merged-in files)', () => {
    const repo = makeRepo();
    try {
      mergeOutOfOrderMain(repo);
      git(['update-ref', '-d', 'refs/remotes/origin/main'], repo.dir);
      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanup(repo);
    }
  });

  it('still fails a misnamed migration the branch newly adds in an ordinary commit, and the remedy forbids renaming shipped files', () => {
    const repo = makeRepo();
    try {
      advanceMain(repo, ['2027-01-04-110000-ticket-merge.sql']);
      git(['merge', '--no-ff', '--no-edit', 'origin/main'], repo.dir);
      addMigration(repo, '2027-01-03-100000-too-early.sql');
      git(['add', '-A'], repo.dir);

      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-03-100000-too-early.sql');
      expect(result.stderr).toContain('2027-01-04-110000-ticket-merge.sql');
      expect(result.stderr).toContain('rename 2027-01-03-100000-too-early.sql');
      expect(result.stderr).toContain('NEVER rename or delete a migration that already exists on');
      // Main's file is named only as the thing to sort after — never as a violation.
      expect(result.stderr).not.toContain('VIOLATION  2027-01-04-110000-ticket-merge.sql');
    } finally {
      cleanup(repo);
    }
  });

  it('still fails an undiscoverable filename the branch newly adds', () => {
    const repo = makeRepo();
    try {
      addMigration(repo, 'no-date-prefix.sql');
      git(['add', '-A'], repo.dir);
      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no-date-prefix.sql');
    } finally {
      cleanup(repo);
    }
  });

  it("fails a migration authored inside the merge commit itself that sorts before main's newest", () => {
    const repo = makeRepo();
    try {
      advanceMain(repo, ['2027-01-04-110000-ticket-merge.sql']);
      git(['merge', '--no-ff', '--no-commit', 'origin/main'], repo.dir);
      addMigration(repo, '2027-01-03-100000-evil-merge.sql');
      git(['add', '-A'], repo.dir);

      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-03-100000-evil-merge.sql');
      expect(result.stderr).not.toContain('VIOLATION  2027-01-04-110000-ticket-merge.sql');
    } finally {
      cleanup(repo);
    }
  });

  it('passes a migration cherry-picked from main (already on origin/main, not authored here)', () => {
    const repo = makeRepo();
    try {
      advanceMain(repo, ['2027-01-04-110000-ticket-merge.sql', '2027-01-04-100300-install-scripts.sql']);
      git(['merge', '--no-ff', '--no-edit', 'origin/main~1'], repo.dir);
      git(['cherry-pick', '--no-commit', 'origin/main'], repo.dir);
      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanup(repo);
    }
  });

  it('fails LOUDLY when a merge renames a shipped migration (the #9997 "fix"), naming the shipped file and the restore command', () => {
    const repo = makeRepo();
    try {
      mergeOutOfOrderMain(repo);
      git(
        ['mv', mig('2027-01-04-110000-ticket-merge.sql'), mig('2027-01-04-110400-ticket-merge.sql')],
        repo.dir,
      );

      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-04-110000-ticket-merge.sql');
      expect(result.stderr).toContain('DELETED or RENAMED');
      expect(result.stderr).toContain(`git checkout origin/main -- ${mig('2027-01-04-110000-ticket-merge.sql')}`);
    } finally {
      cleanup(repo);
    }
  });

  it('fails LOUDLY when an ordinary commit renames a migration that exists on origin/main', () => {
    const repo = makeRepo();
    try {
      git(['mv', mig('2027-01-01-100000-base.sql'), mig('2027-01-09-100000-base.sql')], repo.dir);
      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-01-100000-base.sql');
      expect(result.stderr).toContain('DELETED or RENAMED');
    } finally {
      cleanup(repo);
    }
  });

  it("allows renaming the branch's OWN unshipped migration (the remedy the guard prescribes)", () => {
    const repo = makeRepo();
    try {
      git(
        ['mv', mig('2027-01-02-100000-feature.sql'), mig('2027-01-05-100000-feature.sql')],
        repo.dir,
      );
      const result = runGuard(repo.dir, ['--staged']);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanup(repo);
    }
  });
});

describe('check-migration-naming --against-ref after merging main (#10015)', () => {
  it("after merging main's out-of-order pair, reports only the branch's own file and passes once THAT file is renamed", () => {
    const repo = makeRepo();
    try {
      mergeOutOfOrderMain(repo);
      git(['commit', '--no-edit'], repo.dir);
      // The branch's own 2027-01-02 file now sorts before main's newest; that
      // is a real pre-push violation and is reported as the BRANCH's file.
      const result = runGuard(repo.dir, ['--against-ref', 'origin/main']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-02-100000-feature.sql');
      expect(result.stderr).not.toContain('VIOLATION  2027-01-04-100300-install-scripts.sql');
      expect(result.stderr).not.toContain('VIOLATION  2027-01-04-110000-ticket-merge.sql');

      // Renaming the branch's own file is the fix, and it passes.
      git(
        ['mv', mig('2027-01-02-100000-feature.sql'), mig('2027-01-05-100000-feature.sql')],
        repo.dir,
      );
      commitAll(repo, 'rename own migration');
      const fixed = runGuard(repo.dir, ['--against-ref', 'origin/main']);
      expect(fixed.status, fixed.stderr).toBe(0);
    } finally {
      cleanup(repo);
    }
  });

  it('fails LOUDLY when the branch has renamed a migration that exists on the ref', () => {
    const repo = makeRepo();
    try {
      mergeOutOfOrderMain(repo);
      git(['commit', '--no-edit'], repo.dir);
      git(
        ['mv', mig('2027-01-04-110000-ticket-merge.sql'), mig('2027-01-04-110400-ticket-merge.sql')],
        repo.dir,
      );
      commitAll(repo, 'rename shipped migration');

      const result = runGuard(repo.dir, ['--against-ref', 'origin/main']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-04-110000-ticket-merge.sql');
      expect(result.stderr).toContain('DELETED or RENAMED');

      // Deliberate exception, named file by file.
      const allowed = runGuard(repo.dir, ['--against-ref', 'origin/main'], {
        BREEZE_ALLOW_MIGRATION_DELETE: '2027-01-04-110000-ticket-merge.sql',
      });
      expect(allowed.stderr).toContain('ALLOWED    2027-01-04-110000-ticket-merge.sql');
      expect(allowed.stderr).not.toContain('VIOLATION  2027-01-04-110000-ticket-merge.sql');
      // The branch's own 2027-01-02 file still sorts before main's newest; the
      // escape hatch waives nothing else.
      expect(allowed.status).toBe(1);
      expect(allowed.stderr).toContain('VIOLATION  2027-01-02-100000-feature.sql');
    } finally {
      cleanup(repo);
    }
  });

  // The CI shape: pull_request checks out a merge commit whose first parent is
  // the base, and the step runs --against-ref HEAD^1.
  it("CI shape (--against-ref HEAD^1 on a merge commit) judges only what the PR adds, never the base's files", () => {
    const repo = makeRepo();
    try {
      advanceMain(repo, ['2027-01-04-110000-ticket-merge.sql', '2027-01-04-100300-install-scripts.sql']);
      // Simulate refs/pull/N/merge: base merged with the PR head.
      git(['checkout', '--detach', 'origin/main'], repo.dir);
      git(['merge', '--no-ff', '--no-edit', 'feature'], repo.dir);

      const result = runGuard(repo.dir, ['--against-ref', 'HEAD^1']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('VIOLATION  2027-01-02-100000-feature.sql');
      expect(result.stderr).not.toContain('VIOLATION  2027-01-04-100300-install-scripts.sql');

      // A PR whose own migration sorts last is clean.
      git(['checkout', 'feature'], repo.dir);
      git(
        ['mv', mig('2027-01-02-100000-feature.sql'), mig('2027-01-05-100000-feature.sql')],
        repo.dir,
      );
      commitAll(repo, 'rename own migration');
      git(['checkout', '--detach', 'origin/main'], repo.dir);
      git(['merge', '--no-ff', '--no-edit', 'feature'], repo.dir);
      const clean = runGuard(repo.dir, ['--against-ref', 'HEAD^1']);
      expect(clean.status, clean.stderr).toBe(0);
    } finally {
      cleanup(repo);
    }
  });
});
