export function parsePublishedPort(output: string): number {
  const line = output.split('\n').map((l) => l.trim()).find(Boolean);
  const m = line?.match(/:(\d+)$/);
  if (!m) throw new Error(`Could not find a published port in compose output: ${JSON.stringify(output)} (no published port)`);
  return Number(m[1]);
}

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SEED_SQL = path.join(ROOT, 'e2e-tests', 'seed-fixtures.sql');

export function composeArgs(project: string): string[] {
  if (!existsSync(path.join(ROOT, '.env'))) {
    throw new Error('Missing root .env (needed for digest-pinned image refs). Copy .env.example and fill it first.');
  }
  return [
    'compose', '-p', project,
    '--env-file', '.env', '--env-file', '.env.stack',
    '-f', 'docker-compose.yml',
    '-f', 'docker-compose.override.yml.dev',
    '-f', 'docker-compose.override.yml.worktree',
  ];
}

function docker(args: string[], opts: { input?: string } = {}): string {
  return execFileSync('docker', args, {
    cwd: ROOT,
    input: opts.input,
    encoding: 'utf8',
    stdio: opts.input ? ['pipe', 'pipe', 'inherit'] : ['inherit', 'pipe', 'inherit'],
  });
}

export function composeUp(project: string, opts: { rebuild: boolean }): void {
  const args = [...composeArgs(project), 'up', '-d'];
  if (opts.rebuild) args.push('--build');
  execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
}

export function containerName(project: string, service: string): string {
  const cid = docker([...composeArgs(project), 'ps', '-q', service]).trim();
  if (!cid) throw new Error(`Service ${service} has no container in project ${project}.`);
  return docker(['inspect', '-f', '{{ .Name }}', cid]).trim().replace(/^\//, '');
}

export function publishedPort(project: string, service: string, containerPort: number): number {
  const out = docker([...composeArgs(project), 'port', service, String(containerPort)]);
  return parsePublishedPort(out);
}

export function waitHealthy(project: string, services: string[], timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (const svc of services) {
    const cid = docker([...composeArgs(project), 'ps', '-q', svc]).trim();
    if (!cid) throw new Error(`Service ${svc} has no container — did it fail to start? Check \`docker compose -p ${project} logs ${svc}\`.`);
    for (;;) {
      const status = docker(['inspect', '-f', '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}{{ .State.Status }}{{ end }}', cid]).trim();
      if (status === 'healthy' || status === 'running') break;
      if (status === 'unhealthy' || status === 'exited') {
        throw new Error(`Service ${svc} is ${status}. Logs: \`docker compose -p ${project} logs ${svc}\`.`);
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${svc} to become healthy (last status: ${status}).`);
      execFileSync('sleep', ['2']);
    }
  }
}

export function seedDatabase(project: string): void {
  if (!existsSync(SEED_SQL)) throw new Error(`Seed file not found: ${SEED_SQL}`);
  execFileSync('docker', [...composeArgs(project), 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'breeze', '-d', 'breeze'],
    { cwd: ROOT, input: readFileSync(SEED_SQL, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
}

export function composeDown(project: string, removeVolumes: boolean): void {
  const args = [...composeArgs(project), 'down'];
  if (removeVolumes) args.push('-v');
  execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
}
