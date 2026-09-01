import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Guard against the "the image we scan is not the image we ship" class
 * (issues #4273 / #4260).
 *
 * `security.yml`'s `Trivy Image Scan` job used to build and scan
 * `docker/Dockerfile.api` and `docker/Dockerfile.web` — two files that neither
 * `release.yml` nor `hosted-images.yml` ever publishes. The images customers
 * actually run are built from `apps/api/Dockerfile` and `apps/web/Dockerfile`,
 * and those were scanned nowhere. A green `Trivy Image Scan` therefore said
 * nothing about the two most widely deployed images in the product, which is
 * how they came to ship a known HIGH CVE (CVE-2026-14456, libcrypto3/libssl3)
 * that the *scanned* proxies had already been patched for (#4246 / #4257).
 *
 * The durable defect was the hand-maintained parallel list: a scan roster kept
 * by hand next to a publish roster kept by hand, with nothing tying the two
 * together. So this guard does not hand-list anything. It derives:
 *
 *  - **published** — every `file:` input of every `docker/build-push-action`
 *    step in `release.yml` and `hosted-images.yml` whose step actually pushes
 *    (`push: true`, or `outputs: ...push=true` for the push-by-digest lanes),
 *    with `${{ matrix.* }}` expanded against that job's own matrix.
 *  - **scanned** — the `dockerfile:` values of `security.yml`'s
 *    `trivy-image-scan` matrix.
 *
 * …and asserts published ⊆ scanned, modulo the one recorded exemption below.
 * Add a new published image and this test fails until it is scanned; retarget a
 * publish step at a different Dockerfile and it fails until the scan follows.
 *
 * This is a static read of the workflow YAML; it never invokes Docker or the
 * GitHub API.
 *
 * Scope note: this covers the **CI** gate (`security.yml` runs on every PR,
 * every push to `main`, and weekly). Release-*time* digest scanning
 * (build → scan the exact manifest → promote the tag) exists today only for the
 * three M365 executors; extending it to api/web/portal/binaries means
 * hand-rolling the multi-tag promotion that `docker/metadata-action` currently
 * does for those jobs, and is deliberately left to a follow-up.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const SECURITY_WORKFLOW = '.github/workflows/security.yml';
const SCAN_JOB_ID = 'trivy-image-scan';

/** Workflows that push images to the registry. */
const PUBLISHING_WORKFLOWS = [
  '.github/workflows/release.yml',
  '.github/workflows/hosted-images.yml',
];

/**
 * Published images that the CI scan job deliberately does not build, with the
 * reason recorded. Keep this list at zero entries wherever possible — every
 * entry is a shipped image with no image-level vulnerability gate.
 */
const SCAN_EXEMPT: Record<string, string> = {
  'docker/Dockerfile.binaries':
    'release.yml builds it from `context: staging/` — a release-time artifact ' +
    'directory assembled by earlier jobs that does not exist in a plain repo ' +
    'checkout, so the CI job cannot reproduce the image. Its base is the ' +
    'floating `alpine:3.24` tag (re-pulls upstream fixes on every rebuild ' +
    'rather than freezing a package set behind a digest pin) and its payload is ' +
    'this repo’s own release binaries, which the Trivy filesystem scan ' +
    'already covers.',
};

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Matrix = { include?: Record<string, unknown>[] } & Record<string, unknown>;
type Job = { steps?: Step[]; strategy?: { matrix?: Matrix } };
type Workflow = { jobs?: Record<string, Job> };

function readWorkflow(relPath: string): Workflow {
  return load(readFileSync(path.join(REPO_ROOT, relPath), 'utf8')) as Workflow;
}

/**
 * Every concrete variable binding a job's matrix produces.
 *
 * Only the two shapes these workflows use are supported — a bare `include:`
 * list, and plain list-valued keys. Anything else throws rather than silently
 * expanding to nothing, because a silent empty expansion would drop a published
 * image out of the derived set and make this whole guard pass vacuously.
 */
function matrixCombinations(matrix: Matrix | undefined): Record<string, unknown>[] {
  if (!matrix) return [{}];

  const { include, ...axes } = matrix;
  const axisNames = Object.keys(axes);

  if (include && axisNames.length === 0) return include;

  if (!include && axisNames.length > 0) {
    let combos: Record<string, unknown>[] = [{}];
    for (const name of axisNames) {
      const values = axes[name];
      if (!Array.isArray(values)) {
        throw new Error(`Unsupported matrix axis '${name}': expected a list, got ${typeof values}`);
      }
      combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value })));
    }
    return combos;
  }

  throw new Error(
    'Unsupported matrix shape (mixed `include` + axes). Teach matrixCombinations ' +
      'about it rather than letting the derived image set silently shrink.',
  );
}

/** Substitute `${{ matrix.key }}` in a workflow expression against one binding. */
function expandMatrixRefs(template: string, binding: Record<string, unknown>): string | null {
  let unresolved = false;
  const expanded = template.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_full, key: string) => {
    const value = binding[key];
    if (typeof value !== 'string') {
      unresolved = true;
      return '';
    }
    return value;
  });
  // Any other `${{ ... }}` (env, needs, inputs) means we cannot resolve a
  // concrete path; report it rather than guessing.
  if (unresolved || /\$\{\{/.test(expanded)) return null;
  return expanded;
}

/** True when a build-push-action step publishes the image it builds. */
function stepPushes(inputs: Record<string, unknown>): boolean {
  if (inputs.push === true || inputs.push === 'true') return true;
  const outputs = inputs.outputs;
  return typeof outputs === 'string' && /(^|,)push=true(,|$)/.test(outputs);
}

/** Dockerfiles published to the registry, derived from the release workflows. */
function publishedDockerfiles(): { dockerfile: string; source: string }[] {
  const published: { dockerfile: string; source: string }[] = [];

  for (const workflow of PUBLISHING_WORKFLOWS) {
    const jobs = readWorkflow(workflow).jobs ?? {};
    for (const [jobId, job] of Object.entries(jobs)) {
      const bindings = matrixCombinations(job.strategy?.matrix);
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith('docker/build-push-action')) continue;
        const inputs = step.with ?? {};
        if (!stepPushes(inputs)) continue;
        const file = inputs.file;
        if (typeof file !== 'string') {
          throw new Error(`${workflow} job '${jobId}' pushes without a \`file:\` input`);
        }
        for (const binding of bindings) {
          const resolved = expandMatrixRefs(file, binding);
          if (resolved === null) {
            throw new Error(
              `${workflow} job '${jobId}' has a \`file:\` this guard cannot resolve: ${file}`,
            );
          }
          published.push({ dockerfile: resolved, source: `${workflow}:${jobId}` });
        }
      }
    }
  }

  return published;
}

/** Dockerfiles the CI Trivy image job builds and scans. */
function scannedDockerfiles(): string[] {
  const job = readWorkflow(SECURITY_WORKFLOW).jobs?.[SCAN_JOB_ID];
  if (!job) throw new Error(`${SECURITY_WORKFLOW} has no '${SCAN_JOB_ID}' job`);

  return matrixCombinations(job.strategy?.matrix).map((binding, index) => {
    const dockerfile = binding.dockerfile;
    if (typeof dockerfile !== 'string') {
      throw new Error(`${SCAN_JOB_ID} matrix entry ${index} has no \`dockerfile:\` value`);
    }
    return dockerfile;
  });
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

const PUBLISHED = publishedDockerfiles();
const PUBLISHED_FILES = [...new Set(PUBLISHED.map((entry) => entry.dockerfile))].sort((a, b) =>
  a.localeCompare(b),
);
const SCANNED_FILES = scannedDockerfiles();
const SECURITY_SOURCE = readFileSync(path.join(REPO_ROOT, SECURITY_WORKFLOW), 'utf8');

describe('Trivy image scan covers the images we publish', () => {
  it('derives a non-empty published and scanned set', () => {
    // Sanity: every assertion below is a set comparison, so an empty derivation
    // on either side would pass vacuously while covering nothing.
    expect(PUBLISHED_FILES).toContain('apps/api/Dockerfile');
    expect(PUBLISHED_FILES).toContain('apps/web/Dockerfile');
    expect(PUBLISHED_FILES.length).toBeGreaterThanOrEqual(6);
    expect(SCANNED_FILES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(PUBLISHED_FILES)('%s is built and scanned by the CI Trivy job', (dockerfile) => {
    if (dockerfile in SCAN_EXEMPT) {
      expect(SCANNED_FILES).not.toContain(dockerfile);
      return;
    }

    const publishers = PUBLISHED.filter((entry) => entry.dockerfile === dockerfile)
      .map((entry) => entry.source)
      .join(', ');

    expect(
      SCANNED_FILES,
      `${dockerfile} is pushed to the registry by ${publishers}, but ` +
        `${SECURITY_WORKFLOW}'s ${SCAN_JOB_ID} matrix never builds it — so no ` +
        'image-level vulnerability gate ever looks at the image customers run ' +
        '(issues #4273 / #4260). Add a matrix entry for it, or record a reason ' +
        'in SCAN_EXEMPT.',
    ).toContain(dockerfile);
  });

  it('every scanned Dockerfile exists on disk', () => {
    for (const dockerfile of SCANNED_FILES) {
      expect(
        existsSync(path.join(REPO_ROOT, dockerfile)),
        `${SCAN_JOB_ID} scans ${dockerfile}, which does not exist — the job would ` +
          'fail at build time, or worse, the entry is a typo silently covering nothing.',
      ).toBe(true);
    }
  });

  it('the scan matrix actually drives the build and scan steps', () => {
    // Without this, the matrix could list every published image while the steps
    // kept building a hardcoded one — a roster that looks like coverage and is
    // not. The build step must reference `matrix.dockerfile`, and the scan must
    // still be blocking on HIGH/CRITICAL.
    const job = readWorkflow(SECURITY_WORKFLOW).jobs?.[SCAN_JOB_ID];
    const steps = job?.steps ?? [];

    const buildStep = steps.find((step) => typeof step.run === 'string' && step.run.includes('docker build'));
    expect(buildStep, `${SCAN_JOB_ID} has no \`docker build\` step`).toBeDefined();
    const buildRefs = JSON.stringify([buildStep?.run, buildStep?.env]);
    expect(buildRefs).toMatch(/matrix\.dockerfile/);
    expect(buildRefs).toMatch(/matrix\.image/);

    const scanStep = steps.find((step) => step.uses?.startsWith('aquasecurity/trivy-action'));
    expect(scanStep, `${SCAN_JOB_ID} has no trivy-action step`).toBeDefined();
    expect(String(scanStep?.with?.['image-ref'])).toMatch(/matrix\.image/);
    expect(scanStep?.with?.severity).toBe('HIGH,CRITICAL');
    expect(String(scanStep?.with?.['exit-code'])).toBe('1');

    // The action must stay SHA-pinned like every other third-party action here.
    // (The trailing `# vX.Y.Z` is a YAML comment, so it is not part of `uses`.)
    expect(scanStep?.uses).toMatch(/^aquasecurity\/trivy-action@[0-9a-f]{40}$/);
  });

  it('leaves no Dockerfile silently unclassified', () => {
    // Anti-rot snapshot: a new Dockerfile, or a publish step retargeted at a
    // different file, changes this map and forces a human to decide which side
    // of the line it belongs on instead of quietly losing coverage.
    const classification = Object.fromEntries(
      findDockerfiles().map((dockerfile) => {
        const published = PUBLISHED_FILES.includes(dockerfile);
        const scanned = SCANNED_FILES.includes(dockerfile);
        if (published && scanned) return [dockerfile, 'published + scanned'];
        if (published) return [dockerfile, 'published, scan-exempt'];
        if (scanned) return [dockerfile, 'not published, scanned anyway'];
        return [dockerfile, 'not published, not scanned'];
      }),
    );

    expect(classification).toEqual({
      'apps/api/Dockerfile': 'published + scanned',
      'apps/m365-communications-executor/Dockerfile': 'published + scanned',
      'apps/m365-graph-actions-executor/Dockerfile': 'published + scanned',
      'apps/m365-graph-read-executor/Dockerfile': 'published + scanned',
      'apps/portal/Dockerfile': 'published + scanned',
      'apps/web/Dockerfile': 'published + scanned',
      // Built by ci.yml's smoke test (docker-compose.override.yml.ci) and by the
      // local-build compose mode, so they stay gated even though release never
      // pushes them.
      'docker/Dockerfile.api': 'not published, scanned anyway',
      'docker/Dockerfile.web': 'not published, scanned anyway',
      // See SCAN_EXEMPT: staging/ build context cannot be reproduced in CI.
      'docker/Dockerfile.binaries': 'published, scan-exempt',
      // Hot-reload dev images: floating base tag, never published.
      'docker/Dockerfile.api.dev': 'not published, not scanned',
      'docker/Dockerfile.portal.dev': 'not published, not scanned',
      'docker/Dockerfile.web.dev': 'not published, not scanned',
    });
  });

  it('records a reason for every scan exemption', () => {
    for (const [dockerfile, reason] of Object.entries(SCAN_EXEMPT)) {
      expect(PUBLISHED_FILES, `${dockerfile} is exempted but nothing publishes it`).toContain(
        dockerfile,
      );
      expect(reason.length).toBeGreaterThan(80);
    }
  });

  it('local preflight builds the published api/web images, not the compose proxies', () => {
    // scripts/security/preflight.sh is the "run CI's gates locally" script. It
    // built the same docker/Dockerfile.* proxies, so a developer running it saw
    // the same false green CI did.
    const preflight = readFileSync(path.join(REPO_ROOT, 'scripts/security/preflight.sh'), 'utf8');
    expect(preflight).toContain('-f apps/api/Dockerfile');
    expect(preflight).toContain('-f apps/web/Dockerfile');
  });
});

describe('the coverage derivation is discriminating', () => {
  // These exercise the helpers against synthetic workflows: without them the
  // suite would pass just as happily on a derivation that returned nothing.

  it('counts only steps that actually push', () => {
    const inputs = { file: 'apps/api/Dockerfile' };
    expect(stepPushes({ ...inputs, push: true })).toBe(true);
    expect(stepPushes({ ...inputs, push: false })).toBe(false);
    expect(stepPushes(inputs)).toBe(false);
    expect(
      stepPushes({
        ...inputs,
        outputs: 'type=image,name=ghcr.io/x/api,push-by-digest=true,name-canonical=true,push=true',
      }),
    ).toBe(true);
    // `push-by-digest=true` alone is not a push.
    expect(stepPushes({ ...inputs, outputs: 'type=image,push-by-digest=true' })).toBe(false);
  });

  it('expands matrix references and refuses the ones it cannot resolve', () => {
    expect(expandMatrixRefs('apps/${{ matrix.image }}/Dockerfile', { image: 'web' })).toBe(
      'apps/web/Dockerfile',
    );
    expect(expandMatrixRefs('${{ matrix.dockerfile }}', { dockerfile: 'apps/api/Dockerfile' })).toBe(
      'apps/api/Dockerfile',
    );
    // Unknown axis, and non-matrix expressions, must return null rather than a
    // half-substituted path that silently matches nothing.
    expect(expandMatrixRefs('apps/${{ matrix.image }}/Dockerfile', {})).toBeNull();
    expect(expandMatrixRefs('${{ env.DOCKERFILE }}', {})).toBeNull();
  });

  it('throws on a matrix shape it does not understand', () => {
    expect(() => matrixCombinations({ include: [{ image: 'api' }], image: ['api'] })).toThrow(
      /Unsupported matrix shape/,
    );
    expect(() => matrixCombinations({ image: 'api' })).toThrow(/Unsupported matrix axis/);
    expect(matrixCombinations(undefined)).toEqual([{}]);
    expect(matrixCombinations({ image: ['api', 'web'] })).toEqual([
      { image: 'api' },
      { image: 'web' },
    ]);
  });

  it('would fail if a published Dockerfile were dropped from the scan matrix', () => {
    // The real check is `expect(SCANNED_FILES).toContain(dockerfile)`. Prove it
    // discriminates by running the same comparison against a scan roster with
    // the shipped API image removed.
    const withApiDropped = SCANNED_FILES.filter((f) => f !== 'apps/api/Dockerfile');
    expect(withApiDropped).not.toContain('apps/api/Dockerfile');
    expect(PUBLISHED_FILES).toContain('apps/api/Dockerfile');
  });

  it('reads the security workflow it claims to check', () => {
    expect(SECURITY_SOURCE).toContain('trivy-image-scan:');
  });
});
