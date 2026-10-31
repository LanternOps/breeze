// scripts/dev/wt-stack/down.ts
// The `wt-stack down` sequence, with its side effects injected so the project
// choice and descriptor handling (#9864) are testable.
import { downCandidates, pickExistingProject } from './project';

export interface DownDeps {
  readRecordedProject(worktreePath: string): string | null;
  composeProjectExists(project: string): boolean;
  listBreezeProjects(): string[];
  composeDown(project: string, removeVolumes: boolean): void;
  removeDescriptor(worktreePath: string): void;
  log(message: string): void;
}

export function downStack(
  opts: { worktreePath: string; shared: boolean; keepVolumes: boolean; branch?: string; override?: string },
  deps: DownDeps,
): string {
  const recordedProject = deps.readRecordedProject(opts.worktreePath);
  // #9864 — target the project `up` recorded; fall back to derived names only
  // without a descriptor, and fail loudly rather than `compose down` a project
  // that does not exist (which exits 0 and leaves the real stack running).
  const candidates = downCandidates({
    worktreePath: opts.worktreePath, shared: opts.shared, branch: opts.branch,
    recordedProject, override: opts.override,
  });
  const project = pickExistingProject(candidates, deps.composeProjectExists, deps.listBreezeProjects());
  const legacy = candidates.length > 1 && project !== candidates[0];
  deps.log(
    `[wt-stack] down project=${project}` +
      (legacy ? ' (matched the pre-#9864 branch-derived name)' : '') +
      (opts.keepVolumes ? ' (keeping volumes)' : ''),
  );
  deps.composeDown(project, !opts.keepVolumes);
  // Keep the descriptor with --keep-volumes so the next `up` reattaches the
  // same volumes under the same project.
  if (!opts.keepVolumes && recordedProject === project) deps.removeDescriptor(opts.worktreePath);
  return project;
}
