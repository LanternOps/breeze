import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { descriptorPath } from './project';

export interface StackDescriptor {
  project: string;
  baseUrl: string;
  apiUrl: string;
  portalUrl: string;
  webPort: number;
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
