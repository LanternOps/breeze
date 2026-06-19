// scripts/dev/wt-stack/cli.ts
import { execFileSync } from 'node:child_process';
import { deriveProjectName } from './project';
import { writeDescriptor, readDescriptor, type StackDescriptor } from './descriptor';
import { writeEnvStack } from './env';
import { composeUp, waitHealthy, publishedPort, containerName, seedDatabase, composeDown } from './compose';

const ADMIN = { email: 'admin@breeze.local', password: 'BreezeAdmin123!' };
const HEALTH_SERVICES = ['postgres', 'redis', 'api', 'web', 'portal', 'caddy'];

function currentBranch(): string | undefined {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    return b === 'HEAD' ? undefined : b;
  } catch { return undefined; }
}

function up(shared: boolean, rebuild: boolean): void {
  const worktreePath = process.cwd();
  const project = deriveProjectName({ worktreePath, branch: currentBranch(), shared });
  console.log(`[wt-stack] project=${project} engine=${dockerContext()}`);
  writeEnvStack(worktreePath);
  composeUp(project, { rebuild });
  waitHealthy(project, HEALTH_SERVICES, 5 * 60_000);
  seedDatabase(project);
  const caddyPort = publishedPort(project, 'caddy', 80);
  const baseUrl = `http://localhost:${caddyPort}`;
  const descriptor: StackDescriptor = {
    project,
    baseUrl,
    apiUrl: `${baseUrl}/api`,
    portalUrl: `${baseUrl}/portal`,
    webPort: caddyPort,
    pgContainer: containerName(project, 'postgres'),
    redisContainer: containerName(project, 'redis'),
    admin: ADMIN,
  };
  writeDescriptor(worktreePath, descriptor);
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
  const project = deriveProjectName({ worktreePath: process.cwd(), branch: currentBranch(), shared: process.argv.includes('--shared') });
  composeDown(project, !keepVolumes);
}

function test(passthrough: string[]): void {
  const worktreePath = process.cwd();
  const d = readDescriptor(worktreePath); // throws clear error if not up
  execFileSync('npx', ['playwright', 'test', ...passthrough], {
    cwd: `${worktreePath}/e2e-tests`,
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_STACK_FILE: `${worktreePath}/.breeze-stack.json`,
      E2E_BASE_URL: d.baseUrl,
      E2E_ADMIN_EMAIL: d.admin.email,
      E2E_ADMIN_PASSWORD: d.admin.password,
    },
  });
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'up': up(rest.includes('--shared'), rest.includes('--rebuild')); break;
    case 'info': info(); break;
    case 'down': down(rest.includes('--keep-volumes')); break;
    case 'test': test(rest[0] === '--' ? rest.slice(1) : rest); break;
    default:
      console.error('Usage: wt-stack <up|down|info|test|ls> [--shared] [--rebuild] [--keep-volumes]');
      process.exit(1);
  }
}

main();
