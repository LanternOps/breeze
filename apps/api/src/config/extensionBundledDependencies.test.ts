import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import tsupConfig from '../../tsup.config';

/**
 * Guard against the "dangling third-party external" class of bug (found in review during
 * the workspace-ee-merge branch, before either production image ever shipped).
 *
 * apps/api's tsup build bundles the built-in ee/workspace extension's SOURCE via
 * `noExternal: [/^@breeze\//, ...]` (@breeze/ext-workspace re-exports it). By default,
 * tsup treats a bare import as external (left as a literal `require()` in dist/index.cjs,
 * resolved from node_modules at runtime) only when that specifier is one of apps/api's OWN
 * declared `dependencies` -- everything else reachable from a noExternal-matched module
 * gets bundled by esbuild's ordinary default (bundle=true unless externalized).
 *
 * That means any ee/workspace runtime dependency that is NOT also an apps/api dependency
 * gets bundled automatically today -- but only as a SIDE EFFECT of apps/api happening not
 * to depend on it itself. That's an accident, not a decision: if apps/api ever gained its
 * own same-named dependency (for an unrelated reason), the package would silently flip to
 * externalized, and neither production Dockerfile provisions ee/workspace's own
 * node_modules into the deployed image -- so the next boot would crash with
 * "Cannot find module '<pkg>'" the first time that code path executed, with nothing in CI
 * to catch it (the guard test in dockerfileWorkspaceManifests.test.ts checks Dockerfile
 * COPY completeness, not what tsup actually chooses to bundle vs. externalize).
 *
 * This test pins the actual contract: every ee/workspace runtime dependency must be either
 * (a) also declared as an apps/api dependency -- so it deliberately stays external and
 * resolves from apps/api's own deployed node_modules, which both production Dockerfiles DO
 * provision -- or (b) explicitly listed in apps/api/tsup.config.ts's `noExternal`, an
 * intentional, reviewed decision to ship it bundled instead. A dependency in neither
 * bucket is exactly the bug this guards against.
 */

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function dependencyNames(manifest: Record<string, unknown>): Set<string> {
  return new Set(Object.keys((manifest.dependencies ?? {}) as Record<string, string>));
}

const apiManifest = readJson(path.join(API_ROOT, 'package.json'));
const workspaceManifest = readJson(path.join(REPO_ROOT, 'ee/workspace/package.json'));

const apiDeps = dependencyNames(apiManifest);
const workspaceDeps = dependencyNames(workspaceManifest);

/** Non-`@breeze/*` names: those are handled by the separate `/^@breeze\//` regex entry. */
const workspaceThirdPartyDeps = [...workspaceDeps].filter((name) => !name.startsWith('@breeze/'));

function noExternalStrings(): Set<string> {
  const entries = tsupConfig.noExternal;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  return new Set(list.filter((entry): entry is string => typeof entry === 'string'));
}

describe('ee/workspace bundled-dependency contract (apps/api/tsup.config.ts)', () => {
  it('every ee/workspace third-party runtime dependency is either an apps/api dependency or explicitly noExternal', () => {
    const noExternal = noExternalStrings();
    const dangling = workspaceThirdPartyDeps.filter(
      (name) => !apiDeps.has(name) && !noExternal.has(name),
    );

    expect(
      dangling,
      `ee/workspace/package.json declares ${dangling.join(', ')} as a runtime dependency, but ` +
        "it is neither an apps/api dependency (which would keep it external and resolvable from " +
        "apps/api's own deployed node_modules) nor listed in apps/api/tsup.config.ts's noExternal " +
        '(which would ship it bundled into dist/index.cjs). Left as-is, tsup bundles it today only ' +
        "by accident (apps/api doesn't happen to depend on it), which breaks silently the moment " +
        'that stops being true. Either add it to apps/api/tsup.config.ts noExternal (if pure JS, no ' +
        'native bindings) or add it to apps/api/package.json dependencies (if it should stay external).',
    ).toEqual([]);
  });

  it('every explicitly-bundled third-party entry in noExternal is still a real ee/workspace dependency', () => {
    const noExternal = [...noExternalStrings()].filter((name) => name !== 'dotenv');
    const stale = noExternal.filter((name) => !workspaceThirdPartyDeps.includes(name));

    expect(
      stale,
      `apps/api/tsup.config.ts's noExternal lists ${stale.join(', ')} as explicitly bundled for ` +
        "ee/workspace, but ee/workspace/package.json no longer declares it as a runtime dependency " +
        '(or it moved to apps/api\'s own dependencies, where it belongs instead). Remove the stale ' +
        'entry so noExternal stays an accurate record of what is deliberately inlined.',
    ).toEqual([]);
  });

  it('explicitly-bundled entries do not shadow an apps/api dependency of the same name', () => {
    const noExternal = [...noExternalStrings()].filter((name) => name !== 'dotenv');
    const redundant = noExternal.filter((name) => apiDeps.has(name));

    expect(
      redundant,
      `apps/api/tsup.config.ts's noExternal explicitly bundles ${redundant.join(', ')}, but apps/api ` +
        'already depends on it directly -- it would stay external (and resolve fine from the deployed ' +
        'node_modules) without the explicit entry. Remove it from noExternal to avoid bundling a ' +
        "second, possibly-different-versioned copy alongside apps/api's own.",
    ).toEqual([]);
  });
});
