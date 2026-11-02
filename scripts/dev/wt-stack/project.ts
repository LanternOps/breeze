// scripts/dev/wt-stack/project.ts
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SHARED_PROJECT = 'breeze';

const PREFIX = 'breeze-wt-';
const MAX_LEN = 50;
/** What `docker compose -p` accepts. */
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Compose project names must be lowercase [a-z0-9_-], starting al/num. */
function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sha1(input: string, len: number): string {
  return createHash('sha1').update(input).digest('hex').slice(0, len);
}

/**
 * #9864 — the project for a worktree is keyed on the worktree's path, so it is
 * the same on a branch, a detached HEAD, or after a branch rename. Format:
 * `breeze-wt-<dir-slug>-<6-hex path hash>`; the hash keeps two worktrees with
 * the same directory name apart.
 */
export function deriveProjectName(opts: { worktreePath: string; shared?: boolean }): string {
  if (opts.shared) return SHARED_PROJECT;
  const resolved = path.resolve(opts.worktreePath);
  const hash = sha1(resolved, 6);
  const room = MAX_LEN - PREFIX.length - hash.length - 1;
  const base = slug(path.basename(resolved)).slice(0, room).replace(/-+$/, '');
  return base ? `${PREFIX}${base}-${hash}` : `${PREFIX}${hash}`;
}

/**
 * The pre-#9864 branch-derived name. Only used to find a stack an older
 * wt-stack brought up when there is no descriptor recording its project.
 */
export function legacyBranchProjectName(branch: string | undefined): string | null {
  const base = branch ? slug(branch) : '';
  if (!base) return null;
  const full = `${PREFIX}${base}`;
  if (full.length <= MAX_LEN) return full;
  return `${PREFIX}${base.slice(0, MAX_LEN - PREFIX.length - 7)}-${sha1(base, 6)}`;
}

export interface ResolveOpts {
  worktreePath: string;
  shared?: boolean;
  /** `project` from this worktree's .breeze-stack.json, if one exists. */
  recordedProject?: string | null;
  /** BREEZE_WT_PROJECT. */
  override?: string;
}

export type ProjectSource = 'shared' | 'override' | 'descriptor' | 'path';

/**
 * Precedence: --shared, then BREEZE_WT_PROJECT, then the project `up` recorded
 * in .breeze-stack.json, then the path-derived name. Reading the descriptor
 * first is what keeps `down` aimed at the stack `up` actually started (#9864).
 */
export function resolveProject(opts: ResolveOpts): { project: string; source: ProjectSource } {
  if (opts.shared) return { project: SHARED_PROJECT, source: 'shared' };
  const override = opts.override?.trim();
  if (override) {
    if (!COMPOSE_PROJECT_RE.test(override)) {
      throw new Error(`BREEZE_WT_PROJECT must be a valid compose project name (lowercase a-z, 0-9, _ and -, starting with a letter or digit), got ${JSON.stringify(override)}.`);
    }
    return { project: override, source: 'override' };
  }
  if (opts.recordedProject) {
    if (opts.recordedProject === SHARED_PROJECT) {
      throw new Error(`.breeze-stack.json in ${opts.worktreePath} records the shared "${SHARED_PROJECT}" stack. Pass --shared to act on it.`);
    }
    return { project: opts.recordedProject, source: 'descriptor' };
  }
  return { project: deriveProjectName({ worktreePath: opts.worktreePath }), source: 'path' };
}

/**
 * Projects `down` may tear down, most specific first. With a descriptor or an
 * override that is the only candidate; without one, the path-derived name and
 * then the legacy branch-derived name (stacks from before #9864).
 */
export function downCandidates(opts: ResolveOpts & { branch?: string }): string[] {
  const { project, source } = resolveProject(opts);
  if (source !== 'path') return [project];
  const legacy = legacyBranchProjectName(opts.branch);
  return legacy && legacy !== project ? [project, legacy] : [project];
}

/**
 * #9864 — `docker compose down` on an unknown project exits 0 and does
 * nothing, which is how a running stack was left behind. Pick the first
 * candidate that exists, or fail and say what is actually running.
 */
export function pickExistingProject(
  candidates: string[],
  exists: (project: string) => boolean,
  running: string[],
): string {
  const found = candidates.find(exists);
  if (found) return found;
  const others = running.length ? running.join(', ') : '(none)';
  throw new Error(
    `[wt-stack] No compose project found for this worktree (looked for: ${candidates.join(', ')}). ` +
      `Breeze projects present: ${others}. ` +
      'If one of those is this worktree\'s stack, run `BREEZE_WT_PROJECT=<name> pnpm wt-stack down`. ' +
      'If the stack is already gone, delete this worktree\'s .breeze-stack.json.',
  );
}

/**
 * #9864 — with BREEZE_WT_CADDY_PORT pinned, a second stack for the same
 * worktree would fight the first for the port. `owners` are the compose
 * project labels of containers publishing the port ('' for a bare container).
 */
export function assertCaddyPortAvailable(port: number, project: string, owners: string[]): void {
  const others = [...new Set(owners.filter((o) => o !== project))];
  if (!others.length) return;
  const who = others.map((o) => o || '(a container outside compose)').join(', ');
  throw new Error(
    `[wt-stack] BREEZE_WT_CADDY_PORT=${port} is already published by ${who}, not ${project}. ` +
      'Run `pnpm wt-stack down` for that stack (or `BREEZE_WT_PROJECT=<name> pnpm wt-stack down`), or pick another port.',
  );
}

export function descriptorPath(worktreePath: string): string {
  return path.join(worktreePath, '.breeze-stack.json');
}

export function envStackPath(worktreePath: string): string {
  return path.join(worktreePath, '.env.stack');
}
