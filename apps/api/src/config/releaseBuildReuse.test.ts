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

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

// Model FROM/COPY dependencies, so a future runner COPY from builder cannot
// silently restore compilation in the release packaging path.
function stages(source: string) {
  const result = new Map<string, { body: string; dependencies: string[] }>();
  let current: string | undefined;
  for (const line of source.split('\n')) {
    const from = line.match(/^FROM\s+(\S+)\s+AS\s+(\S+)$/i);
    if (from) {
      current = required(from[2], 'FROM stage alias');
      result.set(current, { body: '', dependencies: [required(from[1], 'FROM source')] });
    } else if (current) {
      const stage = required(result.get(current), `stage ${current}`);
      stage.body += `${line}\n`;
      const copy = line.match(/^COPY\s+--from=(\S+)/i);
      if (copy) stage.dependencies.push(required(copy[1], 'COPY source stage'));
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
    if (!overrides.has(name)) required(graph.get(name), `stage ${name}`).dependencies.forEach(visit);
  }
  visit(required([...graph.keys()].at(-1), 'final Dockerfile stage'));
  return seen;
}

describe.each(['api', 'web'])('release %s compilation reuse', (app) => {
  const dockerfile = read(`apps/${app}/Dockerfile`);
  const build = required(workflow.jobs[`build-${app}`], `build-${app} job`);
  const publish = required(workflow.jobs[`build-docker-${app}`], `build-docker-${app} job`);

  it('uses the compiler for ordinary builds and bypasses it for supplied distributions', () => {
    expect([...stages(dockerfile).keys()].at(-1)).toBe('runner');
    expect(ancestors(dockerfile, new Set())).toContain('builder');
    const packaging = ancestors(dockerfile, new Set(['release-dist']));
    expect(packaging).toContain('release-dist');
    expect(packaging).toContain('deps');
    expect(packaging).not.toContain('builder');
    expect(required(stages(dockerfile).get('runner'), 'runner stage').body).toContain(` /apps/${app}/dist ./apps/${app}/dist`);
  });

  it('maps every exported compiled directory through same-run artifacts into the named context', () => {
    const buildStep = stepsUsing(build, 'docker/build-push-action');
    expect(buildStep).toHaveLength(1);
    const compileStep = required(buildStep[0], 'release compilation step');
    expect(compileStep.with?.target).toBe('release-dist');
    expect(compileStep.with?.push).not.toBe(true);
    expect(compileStep.with?.outputs).toBe(`type=local,dest=\${{ runner.temp }}/${app}-release`);
    const push = stepsUsing(publish, 'docker/build-push-action');
    expect(push).toHaveLength(1);
    const publishStep = required(push[0], 'release publishing step');
    expect(String(publishStep.with?.['build-contexts']).trim()).toBe('release-dist=${{ runner.temp }}/release-dist');

    const exported = [...required(stages(dockerfile).get('release-dist'), 'release-dist stage').body.matchAll(/^COPY --from=builder (\S+) (\S+)$/gm)];
    expect(exported).toHaveLength(app === 'api' ? 2 : 1);
    for (const match of exported) {
      const source = required(match[1], 'exported source path');
      const destination = required(match[2], 'exported destination path');
      expect(source).toBe(`/app${destination}`);
      const upload = required(stepsUsing(build, 'actions/upload-artifact').find((step) =>
        step.with?.path === `\${{ runner.temp }}/${app}-release${destination}`), `upload for ${destination}`);
      expect(upload.with?.['if-no-files-found']).toBe('error');
      const download = required(stepsUsing(publish, 'actions/download-artifact').find((step) =>
        step.with?.name === upload.with?.name), `download for ${destination}`);
      expect(download.with?.path).toBe(`\${{ runner.temp }}/release-dist${destination}`);
      expect(download.with?.['run-id']).toBeUndefined();
      expect(download.with?.repository).toBeUndefined();
    }
    // Preserve the public tarball's layout: its artifact contains dist contents,
    // while API's additional built-in web bundle remains a separate artifact.
    expect(stepsUsing(build, 'actions/upload-artifact').find((step) => step.with?.name === `${app}-dist`)?.with?.path)
      .toBe(`\${{ runner.temp }}/${app}-release/apps/${app}/dist`);
  });

  it('keeps publishing behind release integrity and lineage validation', () => {
    expect(publish.needs).toEqual(expect.arrayContaining([`build-${app}`, 'create-release']));
    expect(publish.if).toContain("needs.create-release.result == 'success'");
    expect(required(workflow.jobs['create-release'], 'create-release job').needs).toEqual(expect.arrayContaining(['release-integrity-gate', 'validate-release-lineage']));
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
  const job = required(check.jobs['verify-release-packaging'], 'verify-release-packaging job');

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
    const compileStep = required(builds[0], 'validation compilation step');
    const packageStep = required(builds[1], 'validation packaging step');
    expect(compileStep.with?.target).toBe('release-dist');
    expect(compileStep.with?.outputs).toBe('type=local,dest=${{ runner.temp }}/release-dist');
    expect(String(packageStep.with?.['build-contexts']).trim()).toBe('release-dist=${{ runner.temp }}/release-dist');
    expect(packageStep.with?.load).toBe(true);
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
