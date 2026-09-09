import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
type Job = { needs?: string[]; if?: string; steps: Step[]; permissions?: Record<string, string> };
const workflow = load(read('.github/workflows/release.yml')) as { jobs: Record<string, Job> };
const stepsUsing = (job: Job, action: string) => job.steps.filter((step) => step.uses?.startsWith(`${action}@`));

// Model FROM/COPY dependencies, so a future runner COPY from builder cannot
// silently restore compilation in the release packaging path.
function stages(source: string) {
  const result = new Map<string, { body: string; dependencies: string[] }>();
  let current: string | undefined;
  for (const line of source.split('\n')) {
    const from = line.match(/^FROM\s+(\S+)\s+AS\s+(\S+)$/i);
    if (from) {
      current = from[2];
      result.set(current, { body: '', dependencies: [from[1]] });
    } else if (current) {
      const stage = result.get(current)!;
      stage.body += `${line}\n`;
      const copy = line.match(/^COPY\s+--from=(\S+)/i);
      if (copy) stage.dependencies.push(copy[1]);
    }
  }
  return result;
}

function ancestors(source: string, overrides: Set<string>) {
  const graph = stages(source);
  const seen = new Set<string>();
  function visit(name: string) {
    if (seen.has(name) || !graph.has(name)) return;
    seen.add(name);
    if (!overrides.has(name)) graph.get(name)!.dependencies.forEach(visit);
  }
  visit([...graph.keys()].at(-1)!);
  return seen;
}

describe.each(['api', 'web'])('release %s compilation reuse', (app) => {
  const dockerfile = read(`apps/${app}/Dockerfile`);
  const build = workflow.jobs[`build-${app}`];
  const publish = workflow.jobs[`build-docker-${app}`];

  it('uses the compiler for ordinary builds and bypasses it for supplied distributions', () => {
    expect([...stages(dockerfile).keys()].at(-1)).toBe('runner');
    expect(ancestors(dockerfile, new Set())).toContain('builder');
    const packaging = ancestors(dockerfile, new Set(['release-dist']));
    expect(packaging).toContain('release-dist');
    expect(packaging).toContain('deps');
    expect(packaging).not.toContain('builder');
    expect(stages(dockerfile).get('runner')!.body).toContain(` /apps/${app}/dist ./apps/${app}/dist`);
  });

  it('maps every exported compiled directory through same-run artifacts into the named context', () => {
    const buildStep = stepsUsing(build, 'docker/build-push-action');
    expect(buildStep).toHaveLength(1);
    expect(buildStep[0].with?.target).toBe('release-dist');
    expect(buildStep[0].with?.push).not.toBe(true);
    expect(buildStep[0].with?.outputs).toBe(`type=local,dest=\${{ runner.temp }}/${app}-release`);
    const push = stepsUsing(publish, 'docker/build-push-action');
    expect(push).toHaveLength(1);
    expect(String(push[0].with?.['build-contexts']).trim()).toBe('release-dist=${{ runner.temp }}/release-dist');

    const exported = [...stages(dockerfile).get('release-dist')!.body.matchAll(/^COPY --from=builder (\S+) (\S+)$/gm)];
    expect(exported).toHaveLength(app === 'api' ? 2 : 1);
    for (const [, source, destination] of exported) {
      expect(source).toBe(`/app${destination}`);
      const upload = stepsUsing(build, 'actions/upload-artifact').find((step) =>
        step.with?.path === `\${{ runner.temp }}/${app}-release${destination}`);
      expect(upload, `missing upload for ${destination}`).toBeDefined();
      expect(upload!.with?.['if-no-files-found']).toBe('error');
      const download = stepsUsing(publish, 'actions/download-artifact').find((step) =>
        step.with?.name === upload!.with?.name);
      expect(download, `missing download for ${destination}`).toBeDefined();
      expect(download!.with?.path).toBe(`\${{ runner.temp }}/release-dist${destination}`);
      expect(download!.with?.['run-id']).toBeUndefined();
      expect(download!.with?.repository).toBeUndefined();
    }
    // Preserve the public tarball's layout: its artifact contains dist contents,
    // while API's additional built-in web bundle remains a separate artifact.
    expect(stepsUsing(build, 'actions/upload-artifact').find((step) => step.with?.name === `${app}-dist`)?.with?.path)
      .toBe(`\${{ runner.temp }}/${app}-release/apps/${app}/dist`);
  });

  it('keeps publishing behind release integrity and lineage validation', () => {
    expect(publish.needs).toEqual(expect.arrayContaining([`build-${app}`, 'create-release']));
    expect(publish.if).toContain("needs.create-release.result == 'success'");
    expect(workflow.jobs['create-release'].needs).toEqual(expect.arrayContaining(['release-integrity-gate', 'validate-release-lineage']));
    expect(build.permissions?.packages).not.toBe('write');
    expect(stepsUsing(build, 'docker/login-action')).toHaveLength(0);
    expect(build.steps.some((step) => step.run?.includes('pnpm build'))).toBe(false);
  });
});


describe('release packaging validation in GitHub Actions', () => {
  const check = load(read('.github/workflows/release-build-check.yml')) as {
    on: { pull_request: { branches: string[]; paths: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, Job & { strategy: { matrix: { app: string[] } } }>;
  };
  const job = check.jobs['verify-release-packaging'];

  it('checks both runtime images when their release build definitions change', () => {
    expect(job.strategy.matrix.app).toEqual(['api', 'web']);
    expect(check.on.pull_request.branches).toEqual(['main']);
    expect(check.on.pull_request.paths).toEqual([
      'apps/api/Dockerfile',
      'apps/web/Dockerfile',
      '.github/workflows/release.yml',
      '.github/workflows/release-build-check.yml',
    ]);
    const builds = stepsUsing(job, 'docker/build-push-action');
    expect(builds).toHaveLength(2);
    expect(builds[0].with?.target).toBe('release-dist');
    expect(builds[0].with?.outputs).toBe('type=local,dest=${{ runner.temp }}/release-dist');
    expect(String(builds[1].with?.['build-contexts']).trim()).toBe('release-dist=${{ runner.temp }}/release-dist');
    expect(builds[1].with?.load).toBe(true);
    for (const build of builds) expect(build.with?.push).toBe(false);
    expect(check.permissions).toEqual({ contents: 'read' });
    expect(stepsUsing(job, 'docker/login-action')).toHaveLength(0);
  });

  it('compares application and built-in workspace bytes without starting services', () => {
    const commands = job.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('docker create');
    expect(commands).not.toMatch(/docker (?:run|start)\b/);
    expect(commands).toContain('docker cp "$container_id:/app/apps/$APP/dist"');
    expect(commands).toContain('diff --recursive --no-dereference "$EXPORT_DIR/apps/$APP/dist"');
    expect(commands).toContain('docker cp "$container_id:/app/apps/api/ee/workspace/dist"');
    expect(commands).toContain('diff --recursive --no-dereference "$EXPORT_DIR/ee/workspace/dist"');
  });
});
