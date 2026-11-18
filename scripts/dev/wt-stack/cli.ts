// scripts/dev/wt-stack/cli.ts
import { execFileSync } from 'node:child_process';
import { resolveProject, assertCaddyPortAvailable, descriptorPath, SHARED_PROJECT } from './project';
import { downStack } from './down';
import { writeDescriptor, readDescriptor, readRecordedProject, removeDescriptor } from './descriptor';
import { writeEnvStack, readStackEnvValue, pinWebAuthnForStack, caddyPortPin } from './env';
import {
  composeUp, waitHealthy, publishedPort, containerName, seedDatabase, composeDown, recreateService,
  listBreezeProjects, composeProjectExists, portOwners,
} from './compose';
import { upStack } from './up';

const ADMIN = { email: 'admin@breeze.local', password: 'BreezeAdmin123!' };

function currentBranch(): string | undefined {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    return b === 'HEAD' ? undefined : b;
  } catch { return undefined; }
}

function up(shared: boolean, rebuild: boolean): void {
  const worktreePath = process.cwd();
  // #9864 — reuse the project this worktree's descriptor recorded, so a
  // checkout (detached HEAD, branch switch) re-ups the same stack, not a second one.
  // A descriptor left by `up --shared` does not pull a plain `up` onto the
  // shared stack (pre-#9864 behaviour); `down` still insists on --shared.
  const recorded = readRecordedProject(worktreePath);
  const { project, source } = resolveProject({
    worktreePath, shared, recordedProject: recorded === SHARED_PROJECT ? null : recorded,
    override: process.env.BREEZE_WT_PROJECT,
  });
  console.log(`[wt-stack] project=${project} (from ${source}) engine=${dockerContext()}`);
  const pinnedCaddyPort = caddyPortPin();
  if (pinnedCaddyPort !== null) assertCaddyPortAvailable(pinnedCaddyPort, project, portOwners(pinnedCaddyPort));
  const descriptor = upStack({ worktreePath, project, rebuild, admin: ADMIN, pinnedCaddyPort }, {
    writeEnvStack, composeUp, waitHealthy, seedDatabase, publishedPort,
    pinWebAuthnForStack, recreateService, containerName, writeDescriptor,
  });
  console.log(JSON.stringify(descriptor, null, 2));
}

function dockerContext(): string {
  try { return execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function info(): void {
  console.log(JSON.stringify(readDescriptor(process.cwd()), null, 2));
}

function down(keepVolumes: boolean): void {
  downStack({
    worktreePath: process.cwd(), shared: process.argv.includes('--shared'), keepVolumes,
    branch: currentBranch(), override: process.env.BREEZE_WT_PROJECT,
  }, {
    readRecordedProject, composeProjectExists, listBreezeProjects, composeDown, removeDescriptor,
    log: (m) => console.log(m),
  });
}

function test(passthrough: string[]): void {
  const worktreePath = process.cwd();
  const d = readDescriptor(worktreePath); // throws clear error if not up
  // #5266 — globalSetup clears the login rate limiter with
  // `redis-cli -a $REDIS_PASSWORD`; this stack's redis requires auth, so an
  // absent value makes that clear silently no-op and 429s the one login the
  // whole suite depends on. The stack is already up here, and compose refuses
  // to boot redis without a password, so a miss means a lookup bug — say so
  // rather than passing '' and reproducing the defect one layer down.
  const redisPassword =
    process.env.REDIS_PASSWORD ?? readStackEnvValue(worktreePath, 'REDIS_PASSWORD');
  if (!redisPassword) {
    throw new Error(
      '[wt-stack test] REDIS_PASSWORD is not in the environment, .env or .env.stack, yet the ' +
        "stack is up — so it can't legitimately be missing. globalSetup's login rate-limit " +
        'clear would silently no-op and 429 the suite. Restore the value (or re-run ' +
        '`wt-stack up`) before testing.'
    );
  }
  execFileSync('npx', ['playwright', 'test', ...passthrough], {
    cwd: `${worktreePath}/e2e-tests`,
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_STACK_FILE: descriptorPath(worktreePath),
      E2E_BASE_URL: d.baseUrl,
      E2E_ADMIN_EMAIL: d.admin.email,
      E2E_ADMIN_PASSWORD: d.admin.password,
      REDIS_PASSWORD: redisPassword,
    },
  });
}

function ls(): void {
  const out = execFileSync('docker', ['compose', 'ls', '--format', 'json'], { encoding: 'utf8' });
  const projects = (JSON.parse(out) as Array<{ Name: string; Status: string }>)
    .filter((p) => p.Name === 'breeze' || p.Name.startsWith('breeze-wt-'));
  if (!projects.length) { console.log('No breeze stacks running.'); return; }
  for (const p of projects) console.log(`${p.Name}\t${p.Status}`);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'up': up(rest.includes('--shared'), rest.includes('--rebuild')); break;
    case 'info': info(); break;
    case 'down': down(rest.includes('--keep-volumes')); break;
    case 'test': test(rest[0] === '--' ? rest.slice(1) : rest); break;
    case 'ls': ls(); break;
    default:
      console.error('Usage: wt-stack <up|down|info|test|ls> [--shared] [--rebuild] [--keep-volumes]');
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
