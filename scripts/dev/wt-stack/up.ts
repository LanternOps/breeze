// scripts/dev/wt-stack/up.ts
// The `wt-stack up` sequence, with its side effects injected so the ordering
// (#6443: WebAuthn pinning needs caddy's published port) is testable.
import type { StackDescriptor } from './descriptor';

export interface UpDeps {
  writeEnvStack(worktreePath: string): void;
  composeUp(project: string, opts: { rebuild: boolean }): void;
  waitHealthy(project: string, services: string[], timeoutMs: number): void;
  seedDatabase(project: string): void;
  publishedPort(project: string, service: string, containerPort: number): number;
  pinWebAuthnForStack(
    worktreePath: string,
    baseUrl: string,
    deps: { recreateApi: () => void; waitApiHealthy: () => void },
  ): boolean;
  recreateService(project: string, service: string): void;
  containerName(project: string, service: string): string;
  writeDescriptor(worktreePath: string, d: StackDescriptor): void;
}

export const HEALTH_SERVICES = ['postgres', 'redis', 'api', 'web', 'portal', 'caddy'];

export function upStack(
  opts: { worktreePath: string; project: string; rebuild: boolean; admin: StackDescriptor['admin'] },
  deps: UpDeps,
): StackDescriptor {
  const { worktreePath, project } = opts;
  deps.writeEnvStack(worktreePath);
  deps.composeUp(project, { rebuild: opts.rebuild });
  deps.waitHealthy(project, HEALTH_SERVICES, 5 * 60_000);
  deps.seedDatabase(project);
  const caddyPort = deps.publishedPort(project, 'caddy', 80);
  const baseUrl = `http://localhost:${caddyPort}`;
  // #6443 — the passkey origin/RP ID are only knowable once caddy's random
  // port is published; pin them and recreate api so it re-reads the env files.
  deps.pinWebAuthnForStack(worktreePath, baseUrl, {
    recreateApi: () => deps.recreateService(project, 'api'),
    waitApiHealthy: () => deps.waitHealthy(project, ['api'], 5 * 60_000),
  });
  const descriptor: StackDescriptor = {
    project,
    baseUrl,
    apiUrl: `${baseUrl}/api`,
    portalUrl: `${baseUrl}/portal`,
    webPort: caddyPort,
    pgContainer: deps.containerName(project, 'postgres'),
    redisContainer: deps.containerName(project, 'redis'),
    admin: opts.admin,
  };
  deps.writeDescriptor(worktreePath, descriptor);
  return descriptor;
}
