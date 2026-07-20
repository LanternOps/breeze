import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against the "Dockerfile workspace-manifest copy scope drift" class
 * (issue #2661). Every image Dockerfile in this repo installs dependencies
 * from a *narrow* set of hand-listed workspace manifests:
 *
 *   COPY apps/web/package.json ./apps/web/
 *   COPY packages/shared/package.json ./packages/shared/
 *   RUN pnpm install --frozen-lockfile --prefer-offline
 *
 * When an app gains a new `workspace:*` dependency and the matching COPY line
 * is not added, pnpm either hard-fails (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, the
 * dev images) or silently installs nothing for that package and the build dies
 * much later with an unresolved-import error (the production images). Normal CI
 * never sees it because every other job does a full workspace install with all
 * manifests present, so `main` stays green and the breakage only surfaces when
 * the image is built — in the release workflow, or on a developer's machine.
 *
 * Five known instances: v0.98.0 shipped with no `breeze/web` image at all,
 * the `a5e457211` follow-up, `docker/Dockerfile.api.dev` (missing
 * `packages/extension-cli`) and `docker/Dockerfile.web.dev` (missing
 * `packages/extension-web-sdk`).
 *
 * This is a manifest-only static check — it never invokes Docker. For each
 * Dockerfile it resolves the *transitive* `workspace:*` graph of the app(s) the
 * image builds and asserts every member has a corresponding
 * `COPY packages/<name>/package.json` line before the `RUN pnpm install`.
 *
 * What counts as missing depends on the install mode, which is read off the real
 * `RUN pnpm install ...` flags in each file rather than assumed — see the
 * FailureMode doc below. In short: an unpinned install (no `--frozen-lockfile`)
 * hard-fails on any unresolvable manifest including devDependencies, while a
 * `--frozen-lockfile` install resolves from the lockfile and only degrades
 * silently, so there it is a finding only for runtime-closure packages whose
 * source the image also compiles.
 */

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Dockerfiles that legitimately install nothing from the pnpm workspace, so
 * there is no manifest scope to check. Keeping this an explicit allowlist (over
 * silently skipping anything we fail to understand) means a Dockerfile that
 * stops copying app manifests can never quietly drop out of the guard.
 */
const NO_WORKSPACE_INSTALL_DOCKERFILES = new Set([
  // Packaging-only image: copies pre-built agent/viewer/helper binaries.
  'docker/Dockerfile.binaries',
]);

type DepField =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

const RUNTIME_DEP_FIELDS: DepField[] = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];

interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/shared`. */
  dir: string;
  name: string;
  /** Workspace-protocol deps, per field. */
  workspaceDeps: Record<DepField, string[]>;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * pnpm-workspace.yaml uses `apps/*` / `packages/*`. Rather than pull in a YAML
 * parser for two globs, enumerate the two directories directly and assert below
 * that the workspace file still says what we assume.
 */
function loadWorkspacePackages(): Map<string, WorkspacePackage> {
  const byName = new Map<string, WorkspacePackage>();
  for (const root of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(REPO_ROOT, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const manifestPath = path.join(REPO_ROOT, dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      const name = manifest.name as string | undefined;
      if (!name) continue;
      const workspaceDeps = {} as Record<DepField, string[]>;
      for (const field of [...RUNTIME_DEP_FIELDS, 'devDependencies'] as DepField[]) {
        const deps = (manifest[field] ?? {}) as Record<string, string>;
        workspaceDeps[field] = Object.entries(deps)
          .filter(([, range]) => typeof range === 'string' && range.startsWith('workspace:'))
          .map(([dep]) => dep);
      }
      byName.set(name, { dir, name, workspaceDeps });
    }
  }
  return byName;
}

interface CopyInstruction {
  sources: string[];
  /** `COPY --from=<stage>` pulls from another build stage, not the build context. */
  fromStage: boolean;
  line: number;
}

interface Stage {
  copies: CopyInstruction[];
  /** Index into `copies` at which the first `pnpm install` RUN appears. */
  installCopyCount: number | null;
  installCommand: string | null;
  installLine: number | null;
}

/** Strip comments and join `\`-continued lines into single logical instructions. */
function logicalInstructions(content: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const rawLines = content.split('\n');
  let buffer = '';
  let startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    if (buffer === '' && /^\s*(#|$)/.test(raw)) continue;
    if (buffer === '') startLine = i + 1;
    const continued = /\\\s*$/.test(raw);
    buffer += raw.replace(/\\\s*$/, ' ');
    if (continued) continue;
    out.push({ text: buffer.trim(), line: startLine });
    buffer = '';
  }
  if (buffer.trim()) out.push({ text: buffer.trim(), line: startLine });
  return out;
}

function parseCopy(text: string, line: number): CopyInstruction | null {
  const tokens = text.split(/\s+/).slice(1);
  const flags = tokens.filter((t) => t.startsWith('--'));
  const operands = tokens.filter((t) => !t.startsWith('--'));
  if (operands.length < 2) return null;
  return {
    sources: operands.slice(0, -1).map((s) => s.replace(/^\.\//, '').replace(/\/+$/, '')),
    fromStage: flags.some((f) => f.startsWith('--from=')),
    line,
  };
}

function parseStages(content: string): Stage[] {
  const stages: Stage[] = [];
  let current: Stage | null = null;
  for (const { text, line } of logicalInstructions(content)) {
    const keyword = /^(\w+)/.exec(text)?.[1]?.toUpperCase();
    if (keyword === 'FROM') {
      current = { copies: [], installCopyCount: null, installCommand: null, installLine: null };
      stages.push(current);
      continue;
    }
    if (!current) continue;
    if (keyword === 'COPY' || keyword === 'ADD') {
      const copy = parseCopy(text, line);
      if (copy) current.copies.push(copy);
      continue;
    }
    // Only build-time installs matter. A `pnpm install` in CMD/ENTRYPOINT runs
    // against the bind-mounted repo at container start, where every manifest is
    // present by construction.
    if (keyword === 'RUN' && /\bpnpm\s+(install|i)\b/.test(text) && current.installCommand === null) {
      current.installCommand = text;
      current.installLine = line;
      current.installCopyCount = current.copies.length;
    }
  }
  return stages;
}

/**
 * `--frozen-lockfile` resolves importers from `pnpm-lock.yaml` instead of from
 * the manifests on disk, which changes the failure mode entirely — see the
 * FailureMode doc below.
 */
function isLockfilePinned(command: string): boolean {
  return /--frozen-lockfile\b/.test(command);
}

/** True when the install pulls devDependencies (i.e. it is not a `--prod` install). */
function installsDevDependencies(command: string): boolean {
  return !/--prod\b|--production\b|NODE_ENV=production/.test(command);
}

/** Does any COPY source make `<dir>/package.json` present in the image? */
function coversManifest(dir: string, sources: string[]): boolean {
  return sources.some(
    (src) => src === '.' || src === dir || src === `${dir}/package.json` || dir.startsWith(`${src}/`),
  );
}

/** Does any COPY source bring in the package's *sources* (not just its manifest)? */
function coversSource(dir: string, sources: string[]): boolean {
  return sources.some(
    (src) =>
      src === '.' ||
      src === dir ||
      dir.startsWith(`${src}/`) ||
      (src.startsWith(`${dir}/`) && src !== `${dir}/package.json`),
  );
}

function findDockerfiles(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, 'apps'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `apps/${entry.name}/Dockerfile`;
    if (existsSync(path.join(REPO_ROOT, rel))) found.push(rel);
  }
  for (const entry of readdirSync(path.join(REPO_ROOT, 'docker'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('Dockerfile')) found.push(`docker/${entry.name}`);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

const WORKSPACE_PACKAGES = loadWorkspacePackages();
const PACKAGES_BY_DIR = new Map([...WORKSPACE_PACKAGES.values()].map((p) => [p.dir, p]));

/** Transitive `workspace:*` closure of `roots`, excluding the roots themselves. */
function resolveWorkspaceClosure(roots: WorkspacePackage[], includeDev: boolean): Set<string> {
  const fields: DepField[] = includeDev ? [...RUNTIME_DEP_FIELDS, 'devDependencies'] : RUNTIME_DEP_FIELDS;
  const required = new Set<string>();
  const queue = [...roots];
  const seen = new Set(roots.map((r) => r.name));
  while (queue.length > 0) {
    const pkg = queue.shift()!;
    for (const field of fields) {
      for (const depName of pkg.workspaceDeps[field]) {
        const dep = WORKSPACE_PACKAGES.get(depName);
        // A `workspace:*` range pointing at a package that is not in the
        // workspace is its own bug — surface it rather than swallow it.
        expect(dep, `${pkg.dir} depends on unknown workspace package ${depName}`).toBeDefined();
        required.add(depName);
        if (!seen.has(depName)) {
          seen.add(depName);
          queue.push(dep!);
        }
      }
    }
  }
  return required;
}

/**
 * The two ways a missing manifest breaks an image. They are NOT the same check,
 * and collapsing them produces false failures in one direction and misses the
 * v0.98.0 bug in the other.
 *
 * `unpinned` — the install has no `--frozen-lockfile` (the dev images:
 *   `RUN pnpm install`). pnpm must resolve every `workspace:*` spec from the
 *   manifests actually on disk, so a missing one is an immediate, loud build
 *   failure:
 *     ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  In apps/api: "@breeze/extension-cli@workspace:*"
 *     is in the dependencies but no package named "@breeze/extension-cli" is
 *     present in the workspace
 *   Every manifest pnpm has to resolve must be present — including root
 *   devDependencies, since a bare `pnpm install` installs those too. This is
 *   what breaks `docker/Dockerfile.api.dev` (verified by a real `docker build`).
 *
 * `pinned` — the install runs `--frozen-lockfile` (every production image).
 *   Importers come from `pnpm-lock.yaml`, so a missing manifest is NOT fatal:
 *   `apps/api/Dockerfile` builds green today without `packages/extension-cli`.
 *   pnpm simply installs nothing for that package. That is harmless right up
 *   until the image *also* copies the package's source in and compiles it — the
 *   v0.98.0 shape, where `apps/web` bundled `packages/extension-web-sdk` with no
 *   node_modules of its own and Rolldown died on `resolve import "zod"`. So for
 *   pinned installs a missing manifest is a finding only when the source is
 *   copied, and only for packages in the *runtime* closure: a root
 *   devDependency is never in the built bundle, which is precisely why
 *   `@breeze/extension-cli` is a non-issue for the production API images.
 *
 * Note the two checks below leave no hole: if a pinned image omits both the
 * manifest and the source of a package it genuinely needs, the manifest check
 * stays quiet but the source-copy check fires.
 */
type FailureMode = 'unpinned' | 'pinned';

interface Analysis {
  dockerfile: string;
  roots: WorkspacePackage[];
  mode: FailureMode;
  installCommand: string;
  /** Closure the manifest check is evaluated against, per the mode. */
  required: Set<string>;
  /** COPY sources available to the install (same stage, before the RUN). */
  installSources: string[];
  /** Every context COPY source in the file, for the source-copy check. */
  allSources: string[];
}

function analyze(dockerfile: string): Analysis | null {
  const content = readFileSync(path.join(REPO_ROOT, dockerfile), 'utf8');
  const stages = parseStages(content);
  const installStage = stages.find((s) => s.installCommand !== null);
  if (!installStage) return null;

  const installSources = installStage.copies
    .slice(0, installStage.installCopyCount!)
    .filter((c) => !c.fromStage)
    .flatMap((c) => c.sources);

  const roots = [...PACKAGES_BY_DIR.values()].filter(
    (pkg) => pkg.dir.startsWith('apps/') && coversManifest(pkg.dir, installSources),
  );
  if (roots.length === 0) return null;

  const installCommand = installStage.installCommand!;
  const mode: FailureMode = isLockfilePinned(installCommand) ? 'pinned' : 'unpinned';
  // Pinned installs only care about what ends up in the built bundle, so root
  // devDependencies are out. Unpinned installs must resolve everything they
  // install, which includes devDependencies unless the install is `--prod`.
  const includeDev = mode === 'unpinned' && installsDevDependencies(installCommand);
  return {
    dockerfile,
    roots,
    mode,
    installCommand,
    required: resolveWorkspaceClosure(roots, includeDev),
    installSources,
    allSources: stages.flatMap((s) => s.copies.filter((c) => !c.fromStage).flatMap((c) => c.sources)),
  };
}

const DOCKERFILES = findDockerfiles();
const ANALYSES = new Map(DOCKERFILES.map((f) => [f, analyze(f)]));
const COVERED = DOCKERFILES.filter((f) => ANALYSES.get(f) !== null);

describe('Dockerfile workspace-manifest copy scope', () => {
  it('discovers every app and docker/ Dockerfile', () => {
    expect(DOCKERFILES).toContain('apps/web/Dockerfile');
    expect(DOCKERFILES).toContain('apps/api/Dockerfile');
    expect(DOCKERFILES).toContain('docker/Dockerfile.web.dev');
    expect(DOCKERFILES).toContain('docker/Dockerfile.api.dev');
    expect(DOCKERFILES.length).toBeGreaterThanOrEqual(8);
  });

  it('assumes the same workspace globs as pnpm-workspace.yaml', () => {
    const workspaceYaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspaceYaml).toMatch(/^\s*-\s*'apps\/\*'\s*$/m);
    expect(workspaceYaml).toMatch(/^\s*-\s*'packages\/\*'\s*$/m);
    expect(workspaceYaml).not.toMatch(/^\s*-\s*'(?!apps\/\*|packages\/\*)/m);
  });

  it('leaves no Dockerfile silently unchecked', () => {
    const unchecked = DOCKERFILES.filter((f) => ANALYSES.get(f) === null);
    expect(
      unchecked,
      'A Dockerfile stopped copying an app manifest before its pnpm install, so this guard can no ' +
        'longer tell what it builds. Either restore the COPY or add it to ' +
        'NO_WORKSPACE_INSTALL_DOCKERFILES with a reason.',
    ).toEqual([...NO_WORKSPACE_INSTALL_DOCKERFILES].filter((f) => DOCKERFILES.includes(f)));
  });

  it.each(COVERED)('%s copies every transitive workspace manifest it installs', (dockerfile) => {
    const analysis = ANALYSES.get(dockerfile)!;
    const missing = [...analysis.required]
      .filter((name) => {
        const dir = WORKSPACE_PACKAGES.get(name)!.dir;
        if (coversManifest(dir, analysis.installSources)) return false;
        // Pinned installs survive a missing manifest — unless the image also
        // compiles the package's source (v0.98.0). See the FailureMode doc.
        return analysis.mode === 'unpinned' || coversSource(dir, analysis.allSources);
      })
      .sort();

    const consequence =
      analysis.mode === 'unpinned'
        ? 'pnpm resolves `workspace:*` from disk here (the install is not `--frozen-lockfile`), so the ' +
          'build fails outright with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND'
        : 'the install is `--frozen-lockfile`, so pnpm silently installs nothing for it while a later ' +
          'stage still copies and compiles its source — the v0.98.0 failure mode, an unresolved-import ' +
          'error at bundle time rather than a missing-package one';

    expect(
      missing,
      `${dockerfile} builds ${analysis.roots.map((r) => r.name).join(', ')} but never copies the ` +
        `manifest for: ${missing.join(', ')}. ${consequence}. Add ` +
        missing
          .map((n) => `\`COPY ${WORKSPACE_PACKAGES.get(n)!.dir}/package.json ./${WORKSPACE_PACKAGES.get(n)!.dir}/\``)
          .join(' and ') +
        ' before the `RUN pnpm install`.',
    ).toEqual([]);
  });

  it('classifies both install modes, so neither branch is vacuous', () => {
    const modes = COVERED.map((f) => `${f}: ${ANALYSES.get(f)!.mode}`).sort();
    // Pinned images are only checked for the silent-degradation shape and
    // unpinned ones only for the hard-failure shape. If a regex change ever
    // collapsed everything into one bucket the guard would keep passing while
    // covering half of what it claims to, so pin the classification itself.
    expect(modes).toEqual([
      'apps/api/Dockerfile: pinned',
      'apps/m365-graph-actions-executor/Dockerfile: pinned',
      'apps/m365-graph-read-executor/Dockerfile: pinned',
      'apps/portal/Dockerfile: pinned',
      'apps/web/Dockerfile: pinned',
      'docker/Dockerfile.api.dev: unpinned',
      'docker/Dockerfile.api: pinned',
      'docker/Dockerfile.portal.dev: unpinned',
      'docker/Dockerfile.web.dev: unpinned',
      'docker/Dockerfile.web: pinned',
    ]);
  });

  it.each(COVERED)('%s copies the source of every workspace package it installs', (dockerfile) => {
    const analysis = ANALYSES.get(dockerfile)!;
    const missing = [...analysis.required]
      .filter((name) => !coversSource(WORKSPACE_PACKAGES.get(name)!.dir, analysis.allSources))
      .sort();

    expect(
      missing,
      `${dockerfile} installs ${missing.join(', ')} but never copies their source into the image, ` +
        'so the workspace link resolves to an empty directory at build/run time.',
    ).toEqual([]);
  });
});
