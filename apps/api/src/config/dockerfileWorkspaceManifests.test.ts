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
 * devDependencies are included only for images that actually install them: an
 * image whose install runs with `--prod` legitimately does not need dev-only
 * manifests, while the dev images (`RUN pnpm install`, no flags) very much do
 * — `@breeze/extension-cli` is a devDependency of `apps/api` and its absence is
 * exactly what breaks `docker/Dockerfile.api.dev`. The install mode is read off
 * the real `RUN pnpm install ...` flags in each file rather than assumed.
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

interface Analysis {
  dockerfile: string;
  roots: WorkspacePackage[];
  includeDev: boolean;
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

  const includeDev = installsDevDependencies(installStage.installCommand!);
  return {
    dockerfile,
    roots,
    includeDev,
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
      .filter((name) => !coversManifest(WORKSPACE_PACKAGES.get(name)!.dir, analysis.installSources))
      .sort();

    expect(
      missing,
      `${dockerfile} builds ${analysis.roots.map((r) => r.name).join(', ')} and installs ` +
        `${analysis.includeDev ? 'dependencies + devDependencies' : 'dependencies only (--prod)'}, ` +
        `but never copies the manifest for: ${missing.join(', ')}. Add ` +
        missing
          .map((n) => `\`COPY ${WORKSPACE_PACKAGES.get(n)!.dir}/package.json ./${WORKSPACE_PACKAGES.get(n)!.dir}/\``)
          .join(' and ') +
        ' before the `RUN pnpm install`.',
    ).toEqual([]);
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
