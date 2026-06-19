// scripts/dev/wt-stack/project.ts
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SHARED_PROJECT = 'breeze';

/** Compose project names must be lowercase [a-z0-9_-], starting al/num. */
function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function deriveProjectName(opts: { worktreePath: string; branch?: string; shared?: boolean }): string {
  if (opts.shared) return SHARED_PROJECT;
  const base = opts.branch ? slug(opts.branch) : '';
  if (base) {
    const full = `breeze-wt-${base}`;
    if (full.length <= 50) return full;
    // Too long: truncate and append a short stable suffix for uniqueness.
    const suffix = createHash('sha1').update(base).digest('hex').slice(0, 6);
    return `breeze-wt-${base.slice(0, 50 - 'breeze-wt-'.length - 7)}-${suffix}`;
  }
  const hash = createHash('sha1').update(opts.worktreePath).digest('hex').slice(0, 8);
  return `breeze-wt-${hash}`;
}

export function descriptorPath(worktreePath: string): string {
  return path.join(worktreePath, '.breeze-stack.json');
}

export function envStackPath(worktreePath: string): string {
  return path.join(worktreePath, '.env.stack');
}
