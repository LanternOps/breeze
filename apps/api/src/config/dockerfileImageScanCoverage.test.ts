import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
 * together. So this guard hand-lists neither. It derives:
 *
 *  - **published** — every `file:` input of every `docker/build-push-action`
 *    step, in every workflow, whose step actually pushes (`push: true`, or
 *    `outputs: ...push=true` for the push-by-digest lanes), with
 *    `${{ matrix.* }}` expanded against that job's own matrix.
 *  - **scanned** — the `dockerfile:` values of `security.yml`'s
 *    `trivy-image-scan` matrix.
 *
 * …and asserts published ⊆ scanned, modulo the one recorded exemption below.
 * Add a new published image and this test fails until it is scanned; retarget a
 * publish step at a different Dockerfile and it fails until the scan follows.
 *
 * Anything the derivation cannot resolve **throws** rather than resolving to
 * nothing. That asymmetry is deliberate: every assertion here is a set
 * comparison, so a derivation that silently shrinks turns the whole suite
 * vacuously green — the same "green means nothing" failure this file exists to
 * prevent, one level up.
 *
 * This is a static read of the workflow YAML; it never invokes Docker or the
 * GitHub API.
 *
 * ## What this guard does NOT prove
 *
 * Recorded so they are not mistaken for coverage:
 *
 *  1. **That the images are clean.** It proves the scan job *looks at* every
 *     published Dockerfile. Whether Trivy then finds something is CI's job.
 *  2. **That the scan job's result blocks a merge.** It does not, today:
 *     `main`'s ruleset requires exactly one status check, `CI Success`, whose
 *     `needs:` list contains no job from this workflow. So a red
 *     `Trivy Image Scan` is *visible* — on the PR, and on `main` — but not
 *     merge-blocking, before or after this change. (That visibility is what
 *     eventually surfaced CVE-2026-14456; see dockerfileOpensslUpgrade.test.ts.)
 *     `runs on pull requests and blocks on failure` below checks what is
 *     checkable from inside the repo — the trigger, the absence of a job-level
 *     `if:`, the absence of `continue-on-error` — but branch protection lives
 *     in repo settings, which no test here can read. Related: the matrix
 *     conversion renamed the check from `Trivy Image Scan` to
 *     `Trivy Image Scan (<image>)`. That is safe only because nothing requires
 *     the old context; if these are ever made required, they must be added as
 *     the eight new per-image contexts.
 *  3. **That the scanned build and the published build are the same bytes.**
 *     CI builds the Dockerfile at PR time; `release.yml` builds it again at tag
 *     time. Only the three M365 executors scan the exact published manifest
 *     before promoting its tag. The snapshot below records, per publishing job,
 *     whether it has a trivy-action step at all — a weaker fact than
 *     "scans the pushed digest", and labelled as the weaker fact deliberately
 *     (see the comment there). It keeps the gap visible; it does not measure it.
 *
 * Sources for the claims above that live outside this repo, so a later reader
 * knows they were checked rather than assumed: the ruleset in (2) was read with
 * `gh api repos/LanternOps/breeze/rulesets` on 2026-09-01 — one rule of type
 * `required_status_checks`, one context, `CI Success`. Re-check it before
 * relying on it; nothing here can.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const WORKFLOW_DIR = '.github/workflows';
const SECURITY_WORKFLOW = `${WORKFLOW_DIR}/security.yml`;
const SCAN_JOB_ID = 'trivy-image-scan';

/**
 * Published images the CI scan job deliberately does not build, with the reason
 * recorded. Keep this at zero entries wherever possible — every entry is a
 * shipped image with no image-level vulnerability gate.
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

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'continue-on-error'?: unknown;
};
type Matrix = { include?: Record<string, unknown>[] } & Record<string, unknown>;
type Job = {
  if?: unknown;
  'continue-on-error'?: unknown;
  steps?: Step[];
  // `matrix` is a string when the workflow computes it at run time
  // (`matrix: ${{ fromJSON(...) }}`).
  strategy?: { matrix?: Matrix | string };
};
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

const BUILD_PUSH_ACTION = 'docker/build-push-action';
const TRIVY_ACTION = 'aquasecurity/trivy-action';

function readWorkflow(relPath: string): Workflow {
  return load(readFileSync(path.join(REPO_ROOT, relPath), 'utf8')) as Workflow;
}

/** Every workflow in the repo, parsed. Derived — nothing here is hand-listed. */
function allWorkflows(): [string, Workflow][] {
  return readdirSync(path.join(REPO_ROOT, WORKFLOW_DIR))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const rel = `${WORKFLOW_DIR}/${name}`;
      return [rel, readWorkflow(rel)] as [string, Workflow];
    });
}

/**
 * Every concrete variable binding a job's matrix produces.
 *
 * Only the two shapes these workflows use are supported — a bare `include:`
 * list, and plain list-valued keys. Anything else throws rather than silently
 * expanding to nothing.
 */
function matrixCombinations(matrix: Matrix | string | undefined): Record<string, unknown>[] {
  if (!matrix) return [{}];

  // A whole-matrix expression (`matrix: ${{ fromJSON(...) }}`, as
  // dev-build-agent.yml uses) is only knowable at run time. Spreading the
  // string would yield one bogus axis per character, so refuse it outright —
  // callers only reach here for jobs that actually build images.
  if (typeof matrix === 'string') {
    throw new Error(
      `Dynamic matrix expression cannot be resolved statically: ${matrix.trim().slice(0, 80)}`,
    );
  }

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
  const expanded = template.replace(
    /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g,
    (_full, key: string) => {
      const value = binding[key];
      if (typeof value !== 'string') {
        unresolved = true;
        return '';
      }
      return value;
    },
  );
  // Any other `${{ ... }}` (env, needs, inputs) means we cannot resolve a
  // concrete path; report it rather than guessing.
  if (unresolved || /\$\{\{/.test(expanded)) return null;
  return expanded;
}

/**
 * Whether a build-push-action step publishes the image it builds.
 *
 * Throws on a `push:` this cannot decide — notably the common
 * `push: ${{ github.event_name != 'pull_request' }}` idiom, which would
 * otherwise make a genuinely published image invisible to the whole guard.
 */
function stepPushes(inputs: Record<string, unknown>, where: string): boolean {
  const push = inputs.push;
  if (push !== undefined) {
    if (push === true || push === 'true') return true;
    if (push === false || push === 'false') return false;
    throw new Error(
      `${where}: cannot decide whether \`push: ${String(push)}\` publishes. Teach ` +
        'stepPushes about it — treating it as "does not push" would drop a shipped ' +
        'image out of the coverage check.',
    );
  }
  const outputs = inputs.outputs;
  if (outputs !== undefined) {
    if (typeof outputs !== 'string') {
      throw new Error(`${where}: unsupported \`outputs:\` of type ${typeof outputs}`);
    }
    // Split into fields and read only `push=`. Other fields routinely
    // interpolate (`name=${{ env.IMAGE_BASE }}/...`) without affecting whether
    // the step publishes. Splitting also survives a YAML block scalar's
    // trailing newline, which an anchored regex over the raw string would miss
    // — silently reclassifying a push-by-digest step as "does not push".
    const fields = outputs.split(',').map((field) => field.trim());
    const pushField = fields.find((field) => field.startsWith('push='));
    if (pushField === undefined) return false;
    const value = pushField.slice('push='.length);
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(
      `${where}: cannot decide whether \`${pushField}\` publishes. Teach stepPushes ` +
        'about it — treating it as "does not push" would drop a shipped image out ' +
        'of the coverage check.',
    );
  }
  // No `push:` and no `push=` field: build-push-action defaults to not pushing.
  return false;
}

/** Dockerfiles published to a registry, derived from every workflow. */
function publishedDockerfiles(): { dockerfile: string; workflow: string; job: string }[] {
  const published: { dockerfile: string; workflow: string; job: string }[] = [];

  for (const [workflow, doc] of allWorkflows()) {
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      const where = `${workflow} job '${jobId}'`;
      // Whether a step pushes needs no matrix, so decide that FIRST. Expanding
      // up front would make a job that merely builds (`push: false`) inside a
      // dynamic matrix throw over a matrix irrelevant to publishing.
      const pushingSteps = (job.steps ?? []).filter(
        (step) => step.uses?.startsWith(BUILD_PUSH_ACTION) && stepPushes(step.with ?? {}, where),
      );
      if (pushingSteps.length === 0) continue;
      // Now the matrix must resolve: this job publishes, so an unresolvable
      // matrix means we cannot know which Dockerfiles it ships.
      const bindings = matrixCombinations(job.strategy?.matrix);
      for (const step of pushingSteps) {
        const inputs = step.with ?? {};
        const file = inputs.file;
        if (typeof file !== 'string') {
          throw new Error(`${where} pushes without a \`file:\` input`);
        }
        for (const binding of bindings) {
          const resolved = expandMatrixRefs(file, binding);
          if (resolved === null) {
            throw new Error(`${where} has a \`file:\` this guard cannot resolve: ${file}`);
          }
          published.push({ dockerfile: resolved, workflow, job: jobId });
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

/**
 * THE predicate this whole file exists to enforce: published images with no
 * scan and no recorded reason. Kept as a pure function so it can be exercised
 * against synthetic rosters below, rather than only against the live one.
 */
function uncoveredPublished(
  published: readonly string[],
  scanned: readonly string[],
  exempt: Readonly<Record<string, string>>,
): string[] {
  return published.filter((file) => !scanned.includes(file) && !(file in exempt));
}

/**
 * Every Dockerfile tracked in the repo, wherever it lives.
 *
 * Tracked, note: this reads the git index, so an *untracked* Dockerfile is
 * invisible to the snapshot below. That is the right trade — CI and release
 * only ever build tracked files, and a path-glob walk would instead miss any
 * Dockerfile outside the two directories it knew about — but the snapshot is
 * the sole backstop for several drift shapes, so the dependency is worth
 * knowing. It fails loud (non-zero `git ls-files`) outside a git checkout
 * rather than returning an empty list.
 */
function findDockerfiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout
    .split('\0')
    .filter((file) => file && path.basename(file).startsWith('Dockerfile'))
    .sort((a, b) => a.localeCompare(b));
}

const PUBLISHED = publishedDockerfiles();
const PUBLISHED_FILES = [...new Set(PUBLISHED.map((entry) => entry.dockerfile))].sort((a, b) =>
  a.localeCompare(b),
);
const SCANNED_FILES = scannedDockerfiles();

describe('Trivy image scan covers the images we publish', () => {
  it('derives a non-empty published and scanned set', () => {
    // Sanity: every assertion below is a set comparison, so an empty derivation
    // on either side would pass vacuously while covering nothing.
    expect(PUBLISHED_FILES).toContain('apps/api/Dockerfile');
    expect(PUBLISHED_FILES).toContain('apps/web/Dockerfile');
    expect(PUBLISHED_FILES.length).toBeGreaterThanOrEqual(6);
    expect(SCANNED_FILES.length).toBeGreaterThanOrEqual(6);
    // The disk walk backstops the derivation, so it must see more than the
    // published set — otherwise a Dockerfile could go missing from both.
    expect(findDockerfiles().length).toBeGreaterThan(PUBLISHED_FILES.length);
  });

  it('leaves no published image unscanned', () => {
    const uncovered = uncoveredPublished(PUBLISHED_FILES, SCANNED_FILES, SCAN_EXEMPT);
    const detail = uncovered
      .map((file) => {
        const publishers = PUBLISHED.filter((entry) => entry.dockerfile === file)
          .map((entry) => `${entry.workflow}:${entry.job}`)
          .join(', ');
        return `  ${file} — pushed by ${publishers}`;
      })
      .join('\n');

    expect(
      uncovered,
      'These Dockerfiles are pushed to a registry but never built by ' +
        `${SECURITY_WORKFLOW}'s ${SCAN_JOB_ID} matrix, so no image-level ` +
        'vulnerability gate ever looks at the image customers run ' +
        `(issues #4273 / #4260):\n${detail}\n` +
        'Add a matrix entry for each, or record a reason in SCAN_EXEMPT.',
    ).toEqual([]);
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
    // kept building a hardcoded one — eight legs all building the API image and
    // reporting a green `Trivy Image Scan (web)`. A roster that looks like
    // coverage and is not, which is this file's whole subject.
    const job = readWorkflow(SECURITY_WORKFLOW).jobs?.[SCAN_JOB_ID];
    const steps = job?.steps ?? [];

    const buildStep = steps.find(
      (step) => typeof step.run === 'string' && step.run.includes('docker build'),
    );
    expect(buildStep, `${SCAN_JOB_ID} has no \`docker build\` step`).toBeDefined();

    // The matrix values reach the shell through `env:` (the injection-safe
    // idiom). Find the variable names by what they carry, so renaming them is
    // fine but dropping the wiring is not.
    const stepEnv = Object.entries(buildStep?.env ?? {});
    const dockerfileVar = stepEnv.find(([, v]) => /matrix\.dockerfile/.test(String(v)))?.[0];
    const imageVar = stepEnv.find(([, v]) => /matrix\.image/.test(String(v)))?.[0];
    expect(dockerfileVar, 'build step does not receive `matrix.dockerfile`').toBeDefined();
    expect(imageVar, 'build step does not receive `matrix.image`').toBeDefined();

    // …and the command must actually consume them, as the `-f` argument
    // itself. One claim about one token: "does the run line mention
    // $DOCKERFILE somewhere" is satisfied by an unrelated `echo`, and a
    // negative "no literal path" check is evaded by writing `./apps/...`.
    // Asserting the argument position can be neither drifted past nor dodged.
    const runLine = buildStep?.run ?? '';
    expect(
      runLine,
      'the build command must pass the matrix Dockerfile as its `-f` argument. ' +
        'Carrying the value in `env:` while `-f` names a path literally satisfies ' +
        '"references the matrix" while every matrix leg builds the same image and ' +
        'still reports per-image check names.',
    ).toMatch(new RegExp(`-f\\s+["']?\\$\\{?${dockerfileVar}\\b`));
    expect(
      runLine,
      'the built tag must carry the matrix image name, or the scan step below ' +
        'would look up an image this step never produced.',
    ).toMatch(new RegExp(`-t\\s+["'][^"']*\\$\\{?${imageVar}\\b`));

    const scanStep = steps.find((step) => step.uses?.startsWith(TRIVY_ACTION));
    expect(scanStep, `${SCAN_JOB_ID} has no trivy-action step`).toBeDefined();
    expect(String(scanStep?.with?.['image-ref'])).toMatch(/matrix\.image/);
    expect(scanStep?.with?.severity).toBe('HIGH,CRITICAL');
    expect(String(scanStep?.with?.['exit-code'])).toBe('1');

    // The action must stay SHA-pinned like every other third-party action here.
    // (The trailing `# vX.Y.Z` is a YAML comment, so it is not part of `uses`.)
    expect(scanStep?.uses).toMatch(new RegExp(`^${TRIVY_ACTION}@[0-9a-f]{40}$`));
  });

  it('the scan job runs on pull requests and blocks on failure', () => {
    // A correct roster on a job that never runs — or that swallows its own
    // failure — is the same false green in a different place.
    const workflow = readWorkflow(SECURITY_WORKFLOW);
    expect(Object.keys(workflow.on ?? {}), `${SECURITY_WORKFLOW} must run on PRs`).toContain(
      'pull_request',
    );

    const job = workflow.jobs?.[SCAN_JOB_ID];
    expect(
      job?.if,
      `${SCAN_JOB_ID} has a job-level \`if:\`, so it may not run on the PRs it is ` +
        'supposed to gate. If the condition is intentional, assert the intent here.',
    ).toBeUndefined();
    expect(job?.['continue-on-error'], `${SCAN_JOB_ID} must fail the run, not warn`).toBeFalsy();
    for (const step of job?.steps ?? []) {
      expect(
        step['continue-on-error'],
        `a step in ${SCAN_JOB_ID} sets continue-on-error, so a HIGH/CRITICAL finding ` +
          'would report green.',
      ).toBeFalsy();
    }
  });

  it('no workflow publishes an image outside docker/build-push-action', () => {
    // The derivation only understands build-push-action steps. A raw
    // `docker push` or `docker buildx build --push` would publish an image the
    // whole guard is blind to.
    for (const [workflow, doc] of allWorkflows()) {
      for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const run = typeof step.run === 'string' ? step.run : '';
          expect(
            /docker\s+push\s|docker\s+buildx\s+build\b[^\n]*--push/.test(run),
            `${workflow} job '${jobId}' publishes an image with a raw docker command. ` +
              'publishedDockerfiles() cannot see it, so its Dockerfile would silently ' +
              'drop out of the scan-coverage check.',
          ).toBe(false);
        }
      }
    }
  });

  it('leaves no Dockerfile silently unclassified', () => {
    // Anti-rot snapshot over every tracked Dockerfile, not just the published
    // ones — it is the backstop for a derivation that shrinks. A new image, or
    // a publish step retargeted at a different file, changes this map and
    // forces a human to decide which side of the line it belongs on.
    const classification = Object.fromEntries(
      findDockerfiles().map((dockerfile) => {
        const published = PUBLISHED_FILES.includes(dockerfile);
        const scanned = SCANNED_FILES.includes(dockerfile);
        if (published && scanned) return [dockerfile, 'published + scanned'];
        if (published && dockerfile in SCAN_EXEMPT) return [dockerfile, 'published, scan-exempt'];
        // Never a resting state: a shipped image with no gate and no reason.
        if (published) return [dockerfile, 'PUBLISHED BUT UNSCANNED'];
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
      // Built from source by ci.yml's smoke test and the local-build compose
      // mode; see `the compose variants are still built from source` below,
      // which derives that rather than trusting this comment.
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

  it('the compose variants are still built from source somewhere', () => {
    // The snapshot keeps docker/Dockerfile.api|web scanned even though release
    // never pushes them, on the grounds that CI's smoke test and the
    // local-build compose mode build them. Derive that instead of asserting it
    // in prose, so the rationale cannot rot while the entries stay.
    const CI_OVERRIDE = 'docker-compose.override.yml.ci';
    const compose = [CI_OVERRIDE, 'docker-compose.override.yml.local-build']
      .map((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8'))
      .join('\n');

    for (const dockerfile of ['docker/Dockerfile.api', 'docker/Dockerfile.web']) {
      expect(
        compose,
        `${dockerfile} is scanned but nothing publishes it and no compose override ` +
          'builds it — either it is dead and both should go, or the reason it is ' +
          'still scanned has changed and belongs in the snapshot above.',
      ).toContain(dockerfile);
    }

    // The override file naming those Dockerfiles is only half the claim; the
    // other half is that CI still runs it. Without this, every `.ci` reference
    // in ci.yml could be repointed elsewhere and the rationale would read as
    // derived while being false.
    expect(
      readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'),
      `ci.yml no longer uses ${CI_OVERRIDE}, so "CI's smoke test builds them" is ` +
        'no longer a reason to keep the compose variants in the scan matrix.',
    ).toContain(CI_OVERRIDE);
  });

  it('records a reason for every scan exemption', () => {
    for (const [dockerfile, reason] of Object.entries(SCAN_EXEMPT)) {
      expect(PUBLISHED_FILES, `${dockerfile} is exempted but nothing publishes it`).toContain(
        dockerfile,
      );
      expect(
        SCANNED_FILES,
        `${dockerfile} is now scanned, so its SCAN_EXEMPT entry is stale — delete it ` +
          'so the exemption list stays an accurate inventory of unguarded images.',
      ).not.toContain(dockerfile);
      expect(reason.length).toBeGreaterThan(80);
    }
  });

  it('marks which published images lack release-time digest scanning', () => {
    // Blind-spot marker, not a gate. CI scans the Dockerfile at PR time;
    // `release.yml` builds it again at tag time. Only jobs that scan the exact
    // pushed manifest before promoting its tag close that window. Snapshotting
    // the split keeps the remaining gap visible and makes closing it a
    // deliberate, reviewed change rather than an invisible non-event.
    const coverage: Record<string, string> = {};
    for (const [workflow, doc] of allWorkflows()) {
      for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
        const steps = job.steps ?? [];
        if (!steps.some((step) => step.uses?.startsWith(BUILD_PUSH_ACTION))) continue;
        const pushes = steps.some(
          (step) =>
            step.uses?.startsWith(BUILD_PUSH_ACTION) &&
            stepPushes(step.with ?? {}, `${workflow} job '${jobId}'`),
        );
        if (!pushes) continue;
        // Label exactly what is checked — the presence of a trivy-action step
        // in the job — and nothing more. The stronger claim ("scans the exact
        // pushed digest before promoting its tag") additionally requires an
        // `image-ref` naming the digest and the build→scan→promote ordering,
        // which check-supply-chain-hardening.sh:321-330 enforces for the
        // executors. Writing that stronger label here from this weaker
        // predicate would put a false coverage claim in the file, which the
        // docblock above then cites: an unrelated `scan-type: fs` step would
        // earn a job the "scans the pushed digest" label, and the natural
        // review action on a snapshot diff is to accept the new label.
        coverage[`${workflow}:${jobId}`] = steps.some((step) => step.uses?.startsWith(TRIVY_ACTION))
          ? 'has a trivy-action step'
          : 'NO trivy-action step';
      }
    }

    expect(coverage).toEqual({
      '.github/workflows/hosted-images.yml:build-m365-executor-image': 'has a trivy-action step',
      '.github/workflows/hosted-images.yml:build-server-image': 'NO trivy-action step',
      '.github/workflows/release.yml:build-binaries-image': 'NO trivy-action step',
      '.github/workflows/release.yml:build-docker-api': 'NO trivy-action step',
      '.github/workflows/release.yml:build-docker-m365-communications-executor':
        'has a trivy-action step',
      '.github/workflows/release.yml:build-docker-m365-graph-actions-executor':
        'has a trivy-action step',
      '.github/workflows/release.yml:build-docker-m365-graph-read-executor':
        'has a trivy-action step',
      '.github/workflows/release.yml:build-docker-portal': 'NO trivy-action step',
      '.github/workflows/release.yml:build-docker-web': 'NO trivy-action step',
    });
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
  // These run the real predicates against synthetic input. Without them the
  // suite would pass just as happily on a derivation that returned nothing.

  it('flags a published image dropped from the scan roster', () => {
    // The exact regression this file exists for, run through the real
    // predicate rather than re-asserting the live rosters.
    const published = ['apps/api/Dockerfile', 'apps/web/Dockerfile'];
    expect(uncoveredPublished(published, published, {})).toEqual([]);
    expect(uncoveredPublished(published, ['apps/web/Dockerfile'], {})).toEqual([
      'apps/api/Dockerfile',
    ]);
    // …and the pre-fix roster: scanning proxies nobody ships covers nothing.
    expect(
      uncoveredPublished(published, ['docker/Dockerfile.api', 'docker/Dockerfile.web'], {}),
    ).toEqual(published);
    // An exemption suppresses the finding — and only for the file it names.
    expect(uncoveredPublished(published, [], { 'apps/api/Dockerfile': 'reason' })).toEqual([
      'apps/web/Dockerfile',
    ]);
  });

  it('counts only steps that actually push, and refuses the ones it cannot decide', () => {
    const inputs = { file: 'apps/api/Dockerfile' };
    const where = 'test';
    expect(stepPushes({ ...inputs, push: true }, where)).toBe(true);
    expect(stepPushes({ ...inputs, push: false }, where)).toBe(false);
    expect(stepPushes(inputs, where)).toBe(false);
    expect(
      stepPushes(
        {
          ...inputs,
          outputs: 'type=image,name=ghcr.io/x/api,push-by-digest=true,name-canonical=true,push=true',
        },
        where,
      ),
    ).toBe(true);
    // `push-by-digest=true` alone is not a push.
    expect(stepPushes({ ...inputs, outputs: 'type=image,push-by-digest=true' }, where)).toBe(false);
    // A YAML block scalar keeps a trailing newline; an anchored regex would
    // read this as "does not push" and drop a shipped image from the guard.
    expect(stepPushes({ ...inputs, outputs: 'type=image,name=x,push=true\n' }, where)).toBe(true);
    // The idiom that would otherwise make a published image invisible.
    expect(() =>
      stepPushes({ ...inputs, push: "${{ github.event_name != 'pull_request' }}" }, where),
    ).toThrow(/cannot decide/);
    expect(() =>
      stepPushes({ ...inputs, outputs: 'type=image,push=${{ inputs.publish }}' }, where),
    ).toThrow(/cannot decide/);
    // An expression in a field that is NOT `push=` says nothing about whether
    // the step publishes — this is the live push-by-digest form.
    expect(
      stepPushes(
        {
          ...inputs,
          outputs:
            'type=image,name=${{ env.IMAGE_BASE }}/api,push-by-digest=true,name-canonical=true,push=true',
        },
        where,
      ),
    ).toBe(true);
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

  it('walks the whole repo for Dockerfiles, not just two directories', () => {
    // The snapshot is the backstop for a shrinking derivation, so its input has
    // to see a Dockerfile wherever someone puts one.
    const found = findDockerfiles();
    expect(found).toContain('apps/api/Dockerfile');
    expect(found).toContain('docker/Dockerfile.binaries');
    // Basename match, not a substring sweep: the test files next to this one
    // have "dockerfile" in their names and are not Dockerfiles.
    expect(found.every((file) => path.basename(file).startsWith('Dockerfile'))).toBe(true);
  });
});
