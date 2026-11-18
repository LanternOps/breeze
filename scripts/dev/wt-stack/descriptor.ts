import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { descriptorPath } from './project';

export interface StackDescriptor {
  project: string;
  baseUrl: string;
  apiUrl: string;
  portalUrl: string;
  webPort: number;
  /** #8718 — true when caddy's host port was fixed via BREEZE_WT_CADDY_PORT, so it survives `docker restart`. */
  caddyPortPinned: boolean;
  pgContainer: string;
  redisContainer: string;
  admin: { email: string; password: string };
}

export function writeDescriptor(worktreePath: string, d: StackDescriptor): void {
  writeFileSync(descriptorPath(worktreePath), JSON.stringify(d, null, 2) + '\n', 'utf8');
}

export function readDescriptor(worktreePath: string): StackDescriptor {
  const p = descriptorPath(worktreePath);
  if (!existsSync(p)) {
    throw new Error(`No stack descriptor at ${p}. Run \`wt-stack up\` first.`);
  }
  return JSON.parse(readFileSync(p, 'utf8')) as StackDescriptor;
}

/**
 * #9864 — the project `up` recorded for this worktree, or null when there is no
 * descriptor. A descriptor that exists but cannot be read is an error: guessing
 * a name instead is how `down` ended up aimed at a stack that was not running.
 */
export function readRecordedProject(worktreePath: string): string | null {
  const p = descriptorPath(worktreePath);
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`Stack descriptor ${p} is not valid JSON (${(err as Error).message}). Fix or delete it, or set BREEZE_WT_PROJECT.`);
  }
  const project = (parsed as { project?: unknown } | null)?.project;
  if (typeof project !== 'string' || !project) {
    throw new Error(`Stack descriptor ${p} has no "project". Fix or delete it, or set BREEZE_WT_PROJECT.`);
  }
  return project;
}

export function removeDescriptor(worktreePath: string): void {
  rmSync(descriptorPath(worktreePath), { force: true });
}
