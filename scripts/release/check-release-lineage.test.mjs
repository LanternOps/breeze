import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as workflowSecurity from '../../.github/scripts/check-workflow-security.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'check-release-lineage.sh');
const SEMVER_TOOL = join(REPO_ROOT, 'scripts', 'release', 'sort-semver-tags.mjs');
const REGISTRY = '.github/release-provenance/candidate-tags.tsv';
const RELEASE_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const DRIFT_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'drift-detector.yml');
const PROMOTION_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release-promotion.yml');
const PROMOTION_RUNBOOK = join(
  REPO_ROOT,
  'docs',
  'runbooks',
  '2026-08-29-release-lineage-promotion.md',
);
const scratch = mkdtempSync(join(tmpdir(), 'release-lineage-test-'));
let fixtureNumber = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function command(cwd, executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    ...options,
  });
}

function git(cwd, ...args) {
  const result = command(cwd, 'git', args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function write(repo, path, contents) {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function commit(repo, message, files = { 'fixture.txt': `${message}\n` }) {
  for (const [path, contents] of Object.entries(files)) {
    write(repo, path, contents);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function initRepo() {
  const repo = join(scratch, `repo-${fixtureNumber++}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Release Lineage Test');
  git(repo, 'config', 'user.email', 'release-lineage@example.invalid');
  commit(repo, 'initial', {
    [REGISTRY]: '# tag\tcommit\tintegration-ref\tnote\n',
    'fixture.txt': 'initial\n',
  });
  return repo;
}

function registryRow(tag, sha, ref = '#4227', note = 'test candidate') {
  return `${tag}\t${sha}\t${ref}\t${note}\n`;
}

function setRegistry(repo, contents) {
  commit(repo, 'update candidate registry', {
    [REGISTRY]: `# tag\tcommit\tintegration-ref\tnote\n${contents}`,
  });
}

function makeCandidate(repo, tag = 'v1.1.0-rc.1') {
  git(repo, 'switch', '-c', 'candidate');
  const sha = commit(repo, 'candidate change', { 'candidate.txt': `${tag}\n` });
  git(repo, 'tag', tag);
  git(repo, 'switch', 'main');
  return { sha, tag };
}

function run(repo, args, options = {}) {
  return command(repo, 'bash', [SCRIPT, ...args], options);
}

function standardArgs(tag, registryRef = 'main') {
  return [
    '--tag', tag,
    '--main-ref', 'main',
    '--candidate-registry-ref', registryRef,
  ];
}

function assertFailure(result, pattern) {
  assert.notEqual(result.status, 0, `expected failure\nstdout: ${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

test('workflow security exposes its YAML and expression parsers', () => {
  assert.equal(typeof workflowSecurity.activeLines, 'function');
  assert.equal(typeof workflowSecurity.workflowJobs, 'function');
  assert.equal(typeof workflowSecurity.topLevelLogicalParts, 'function');
});

test('tag ordering follows SemVer prerelease precedence', () => {
  const tags = [
    'v1.0.0-beta.11',
    'v1.0.0-alpha',
    'v1.0.0',
    'v1.0.0-beta.2',
    'v1.0.0-alpha.beta',
    'v1.0.0-rc.1',
    'v1.0.0-beta',
    'v1.0.0-alpha.1',
    'v1.0.0-alpha-1',
  ];
  const result = command(REPO_ROOT, 'node', [SEMVER_TOOL, '--sort-desc'], {
    input: `${tags.join('\n')}\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'v1.0.0',
    'v1.0.0-rc.1',
    'v1.0.0-beta.11',
    'v1.0.0-beta.2',
    'v1.0.0-beta',
    'v1.0.0-alpha-1',
    'v1.0.0-alpha.beta',
    'v1.0.0-alpha.1',
    'v1.0.0-alpha',
  ]);
});

const releaseLines = workflowSecurity.activeLines(
  readFileSync(RELEASE_WORKFLOW, 'utf8'),
);
const releaseJobs = new Map(
  workflowSecurity.workflowJobs(releaseLines).map((job) => [job.name, job]),
);

function requiredReleaseJob(name) {
  const job = releaseJobs.get(name);
  assert.ok(job, `release workflow must define job ${name}`);
  return job;
}

function directJobScalar(job, key) {
  const propertyIndent = job.lines[0].indent + 2;
  const propertyIndex = job.lines.findIndex((line, index) => (
    index > 0
    && !line.isBlockScalarContent
    && line.indent === propertyIndent
    && line.trimmed.startsWith(`${key}:`)
  ));
  assert.notEqual(propertyIndex, -1, `${job.name} must define ${key}`);

  const property = job.lines[propertyIndex];
  const value = property.trimmed.slice(`${key}:`.length).trim();
  if (!/^[>|][0-9+-]*$/u.test(value)) {
    return value;
  }

  const parts = [];
  for (let index = propertyIndex + 1; index < job.lines.length; index += 1) {
    if (!job.lines[index].isBlockScalarContent) {
      break;
    }
    parts.push(job.lines[index].trimmed);
  }
  return parts.join(' ');
}

function jobText(job) {
  return job.lines.map((line) => line.content).join('\n');
}

function jobNeeds(job) {
  const value = directJobScalar(job, 'needs');
  assert.ok(value.startsWith('[') && value.endsWith(']'), `${job.name} needs must be a flow list`);
  return value.slice(1, -1).split(',').map((need) => need.trim());
}

function dependsOn(jobName, requiredName, visited = new Set()) {
  if (jobName === requiredName) {
    return true;
  }
  if (visited.has(jobName)) {
    return false;
  }
  visited.add(jobName);

  const job = requiredReleaseJob(jobName);
  const needsLine = job.lines.find((line, index) => (
    index > 0
    && !line.isBlockScalarContent
    && line.indent === job.lines[0].indent + 2
    && line.trimmed.startsWith('needs:')
  ));
  if (!needsLine) {
    return false;
  }

  return jobNeeds(job).some((need) => dependsOn(need, requiredName, visited));
}

function blockScalarEntries(job, key) {
  const entries = [];

  for (const [index, line] of job.lines.entries()) {
    if (line.isBlockScalarContent || line.trimmed !== `${key}: |`) {
      continue;
    }
    const nestedEntries = [];
    for (let nestedIndex = index + 1; nestedIndex < job.lines.length; nestedIndex += 1) {
      if (!job.lines[nestedIndex].isBlockScalarContent) {
        break;
      }
      nestedEntries.push(job.lines[nestedIndex].trimmed);
    }
    entries.push(nestedEntries);
  }

  return entries;
}

test('release validation uses the tag publication gate and authoritative main refs', () => {
  const validation = requiredReleaseJob('validate-release-lineage');
  const createRelease = requiredReleaseJob('create-release');
  const requiredGate = [
    "github.ref_type == 'tag'",
    "startsWith(github.ref, 'refs/tags/v')",
    "!(github.event_name == 'workflow_dispatch' && inputs.skip_release)",
  ];
  const validationParts = workflowSecurity
    .topLevelLogicalParts(directJobScalar(validation, 'if'), '&&')
    .map((part) => part.trim());
  const createReleaseParts = workflowSecurity
    .topLevelLogicalParts(directJobScalar(createRelease, 'if'), '&&')
    .map((part) => part.trim());

  assert.deepEqual(validationParts, requiredGate);
  for (const conjunct of requiredGate) {
    assert.ok(
      createReleaseParts.includes(conjunct),
      `create-release must retain gate conjunct: ${conjunct}`,
    );
  }

  const validationText = jobText(validation);
  assert.ok(validationText.includes('permissions:'));
  assert.ok(validationText.includes('contents: read'));
  assert.ok(validationText.includes('fetch-depth: 0'));
  assert.ok(validationText.includes('fetch-tags: true'));
  assert.ok(validationText.includes("git rev-parse --verify 'origin/main^{commit}'"));
  assert.ok(validationText.includes('--main-ref origin/main'));
  assert.ok(validationText.includes('--candidate-registry-ref origin/main'));
});

test('release validation exposes classifier outputs to the publication boundary', () => {
  const validationText = jobText(requiredReleaseJob('validate-release-lineage'));

  assert.ok(validationText.includes("channel: ${{ steps.lineage.outputs.channel }}"));
  assert.ok(validationText.includes("tag: ${{ steps.lineage.outputs.tag }}"));
  assert.ok(validationText.includes("tag_sha: ${{ steps.lineage.outputs.tag_sha }}"));
  assert.ok(validationText.includes('id: lineage'));
  assert.ok(validationText.includes('--tag "$RELEASE_TAG"'));
});

test('create-release requires successful release-lineage validation', () => {
  const createRelease = requiredReleaseJob('create-release');
  const ifParts = workflowSecurity
    .topLevelLogicalParts(directJobScalar(createRelease, 'if'), '&&')
    .map((part) => part.trim());

  assert.ok(jobNeeds(createRelease).includes('validate-release-lineage'));
  assert.ok(ifParts.includes("needs.validate-release-lineage.result == 'success'"));
});

test('candidate channel always creates a draft release', () => {
  const createReleaseText = jobText(requiredReleaseJob('create-release'));

  assert.ok(createReleaseText.includes(
    "draft: ${{ needs.validate-release-lineage.outputs.channel == 'candidate' || vars.RELEASE_DRAFT_FIRST == 'true' }}",
  ));
});

test('every GHCR publisher remains transitively behind create-release', () => {
  const publishers = [...releaseJobs.values()]
    .filter((job) => job.lines.some((line) => line.trimmed === 'packages: write'));
  assert.ok(publishers.length > 0, 'release workflow must contain GHCR publishers');

  for (const publisher of publishers) {
    assert.ok(
      dependsOn(publisher.name, 'create-release'),
      `${publisher.name} must depend transitively on create-release`,
    );
  }
});

test('prerelease GHCR publishers preserve exact-version and SHA-only tagging', () => {
  const publishers = [...releaseJobs.values()]
    .filter((job) => job.lines.some((line) => line.trimmed === 'packages: write'));

  for (const publisher of publishers) {
    const publisherText = jobText(publisher);
    if (publisherText.includes('docker/metadata-action@')) {
      const tagBlocks = blockScalarEntries(publisher, 'tags');
      assert.equal(tagBlocks.length, 1, `${publisher.name} must define one metadata tag block`);
      assert.deepEqual(tagBlocks[0], [
        'type=semver,pattern={{version}}',
        'type=semver,pattern={{major}}.{{minor}}',
        'type=semver,pattern={{major}}',
        "type=raw,value=latest,enable=${{ !contains(github.ref_name, '-') }}",
        'type=sha',
      ]);
      continue;
    }

    assert.ok(publisherText.includes('--tag "${EXECUTOR_REPOSITORY}:${VERSION}"'));
    assert.ok(publisherText.includes('--tag "${EXECUTOR_REPOSITORY}:sha-${SHORT_SHA}"'));
    assert.ok(!publisherText.includes('--tag "${EXECUTOR_REPOSITORY}:latest"'));
  }
});

test('drift monitoring classifies candidates before the side-branch fallback', () => {
  const driftText = readFileSync(DRIFT_WORKFLOW, 'utf8');
  const classifierIndex = driftText.indexOf('scripts/release/check-release-lineage.sh');
  const fallbackIndex = driftText.indexOf(
    'PROVENANCE=.github/release-provenance/side-branch-tags.tsv',
  );

  assert.notEqual(classifierIndex, -1, 'drift must invoke the shared lineage classifier');
  assert.ok(
    classifierIndex < fallbackIndex,
    'candidate classification must run before the stable side-branch fallback',
  );
  assert.ok(driftText.includes('--main-ref origin/main'));
  assert.ok(driftText.includes('--candidate-registry-ref origin/main'));
  assert.ok(driftText.includes('--allow-unclassified'));
  assert.match(driftText, /channel[^\n]*candidate[\s\S]*candidate release lineage/i);
  assert.match(driftText, /channel[^\n]*unclassified[\s\S]*side-branch-tags\.tsv/i);
});

test('drift monitoring retains root and stale-equivalent checks', () => {
  const driftText = readFileSync(DRIFT_WORKFLOW, 'utf8');

  assert.ok(driftText.includes('EXPECTED_ROOT=93bad0ec76d6f0134ed3b21ee7bfef224b4c102e'));
  assert.ok(driftText.includes('git rev-list --max-parents=0 origin/main'));
  assert.ok(driftText.includes('git merge-base --is-ancestor "$EXPECTED_EQUIV" origin/main'));
});

test('promotion is manual-only with a least-privilege publication job', () => {
  const promotionText = readFileSync(PROMOTION_WORKFLOW, 'utf8');
  const promotionLines = workflowSecurity.activeLines(promotionText);
  const promotionJobs = workflowSecurity.workflowJobs(promotionLines);

  assert.match(promotionText, /\non:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(promotionText, /^\s{2}(?:push|pull_request|schedule):/mu);
  assert.match(promotionText, /\npermissions:\n  contents: read\n/);
  assert.equal(promotionJobs.length, 1, 'promotion must have one bounded publisher job');
  assert.ok(jobText(promotionJobs[0]).includes('contents: write'));
  assert.equal(
    promotionLines.filter((line) => line.trimmed === 'contents: write').length,
    1,
    'only the publisher may receive contents: write',
  );
});

test('promotion requires authoritative mainline and an exact matching draft', () => {
  const promotionText = readFileSync(PROMOTION_WORKFLOW, 'utf8');

  assert.ok(promotionText.includes('ref: main'));
  assert.ok(promotionText.includes('fetch-depth: 0'));
  assert.ok(promotionText.includes('fetch-tags: true'));
  assert.ok(promotionText.includes('persist-credentials: false'));
  assert.ok(promotionText.includes('--main-ref origin/main'));
  assert.ok(promotionText.includes('--candidate-registry-ref origin/main'));
  assert.ok(promotionText.includes('--require-mainline'));
  assert.ok(promotionText.includes('gh release view "$TAG" --json isDraft,tagName'));
  assert.ok(promotionText.includes('git rev-parse "$TAG^{commit}"'));
  assert.match(promotionText, /tag_sha/);
  assert.match(promotionText, /isDraft/);
  assert.match(promotionText, /tagName/);
  assert.doesNotMatch(promotionText, /targetCommitish/);
  assert.ok(promotionText.includes('gh release edit "$TAG" --draft=false'));
});

test('promotion cannot rebuild, retag, publish images, or deploy', () => {
  const promotionText = readFileSync(PROMOTION_WORKFLOW, 'utf8');

  for (const forbidden of [
    /\bgo build\b/,
    /\bpnpm build\b/,
    /docker\/(?:build-push|login)-action/,
    /\bdocker push\b/,
    /\bgh workflow run\b/,
    /\bgit tag\b/,
    /\bgit push\b/,
    /\bdeploy\b/i,
  ]) {
    assert.doesNotMatch(promotionText, forbidden);
  }

  const releaseText = readFileSync(RELEASE_WORKFLOW, 'utf8');
  assert.doesNotMatch(releaseText, /Publish with: gh release edit/);
  assert.match(releaseText, /release-promotion\.yml/);
});

test('operator runbook forbids bypassing guarded promotion', () => {
  const runbookText = readFileSync(PROMOTION_RUNBOOK, 'utf8');

  assert.match(runbookText, /release-promotion\.yml/);
  assert.match(runbookText, /bypass[^\n]*violates the release-lineage contract/i);
  assert.match(
    runbookText,
    /exact tagged commit[\s\S]{0,100}reachable from `origin\/main`/i,
  );
  assert.match(runbookText, /do not move[^\n]*tag/i);
});

test('annotated reachable tag is mainline and reports the peeled commit', () => {
  const repo = initRepo();
  const commitSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', '-a', 'v1.0.0', '-m', 'release v1.0.0');
  const tagObjectSha = git(repo, 'rev-parse', 'v1.0.0');
  assert.notEqual(tagObjectSha, commitSha);

  const result = run(repo, standardArgs('v1.0.0'));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-lineage: channel=mainline/);
  assert.match(result.stdout, new RegExp(`tag_sha=${commitSha}`));
  assert.doesNotMatch(result.stdout, new RegExp(`tag_sha=${tagObjectSha}`));
});

test('release validation rejects leading-zero SemVer identifiers', async (t) => {
  for (const invalidTag of ['v01.0.0', 'v1.0.0-01']) {
    await t.test(invalidTag, () => {
      const repo = initRepo();
      git(repo, 'tag', invalidTag);

      assertFailure(run(repo, standardArgs(invalidTag)), /invalid.*SemVer|leading zero/i);
    });
  }
});

test('successful classification writes exact GitHub Actions outputs', () => {
  const repo = initRepo();
  const commitSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'v1.0.0');
  const outputPath = join(repo, 'github-output.txt');
  writeFileSync(outputPath, '');

  const result = run(repo, standardArgs('v1.0.0'), {
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(outputPath, 'utf8'),
    `channel=mainline\ntag=v1.0.0\ntag_sha=${commitSha}\n`,
  );
});

test('exact registered non-main prerelease is a candidate', () => {
  const repo = initRepo();
  const { sha, tag } = makeCandidate(repo);
  setRegistry(repo, registryRow(tag, sha));

  const result = run(repo, standardArgs(tag));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-lineage: channel=candidate/);
  assert.match(result.stdout, new RegExp(`tag_sha=${sha}`));
});

test('stable non-main and unregistered prerelease tags fail closed', async (t) => {
  await t.test('stable non-main tag', () => {
    const repo = initRepo();
    const { tag } = makeCandidate(repo, 'v1.1.0');
    assertFailure(run(repo, standardArgs(tag)), /stable.*not.*main|unclassified/is);
  });

  await t.test('unregistered prerelease tag', () => {
    const repo = initRepo();
    const { tag } = makeCandidate(repo);
    assertFailure(run(repo, standardArgs(tag)), /not registered|unclassified/is);
  });
});

test('duplicate and malformed registry rows fail before classification', async (t) => {
  const cases = [
    {
      name: 'duplicate tag',
      rows: (tag, sha) => registryRow(tag, sha) + registryRow(tag, sha, '#other'),
      pattern: /duplicate/i,
    },
    {
      name: 'malformed tag',
      rows: (_tag, sha) => registryRow('candidate-one', sha),
      pattern: /invalid.*tag|malformed/i,
    },
    {
      name: 'malformed sha',
      rows: (tag) => registryRow(tag, 'ABC123'),
      pattern: /invalid.*sha|malformed/i,
    },
    {
      name: 'missing integration ref',
      rows: (tag, sha) => registryRow(tag, sha, ''),
      pattern: /integration|field|malformed/i,
    },
    {
      name: 'missing note',
      rows: (tag, sha) => registryRow(tag, sha, '#4227', ''),
      pattern: /note|field|malformed/i,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const repo = initRepo();
      const { sha, tag } = makeCandidate(repo);
      setRegistry(repo, entry.rows(tag, sha));
      assertFailure(run(repo, standardArgs(tag)), entry.pattern);
    });
  }
});

test('registry SHA must equal the peeled tag commit', () => {
  const repo = initRepo();
  const { tag } = makeCandidate(repo);
  const wrongSha = git(repo, 'rev-parse', 'main');
  setRegistry(repo, registryRow(tag, wrongSha));

  assertFailure(run(repo, standardArgs(tag)), /does not match|mismatch/i);
});

test('candidate branch cannot authorize itself through a branch-only ledger', () => {
  const repo = initRepo();
  const { sha, tag } = makeCandidate(repo);
  git(repo, 'switch', 'candidate');
  setRegistry(repo, registryRow(tag, sha));

  assertFailure(run(repo, standardArgs(tag, 'main')), /not registered|unclassified/is);
});

test('--allow-unclassified reports an explicit unclassified channel', () => {
  const repo = initRepo();
  const { tag } = makeCandidate(repo, 'v1.1.0');

  const result = run(repo, [...standardArgs(tag), '--allow-unclassified']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-lineage: channel=unclassified/);
});

test('--require-mainline rejects an otherwise valid candidate', () => {
  const repo = initRepo();
  const { sha, tag } = makeCandidate(repo);
  setRegistry(repo, registryRow(tag, sha));

  assertFailure(
    run(repo, [...standardArgs(tag), '--require-mainline']),
    /mainline.*required|candidate.*cannot.*promot/is,
  );
});

test('shallow clone fails before tag classification', () => {
  const source = initRepo();
  git(source, 'tag', '-a', 'v1.0.0', '-m', 'release v1.0.0');
  const clone = join(scratch, `shallow-${fixtureNumber++}`);
  const cloneResult = command(scratch, 'git', [
    'clone',
    '--depth=1',
    '--branch=main',
    pathToFileURL(source).href,
    clone,
  ]);
  assert.equal(cloneResult.status, 0, cloneResult.stderr);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');

  const result = run(clone, [
    '--tag', 'v-does-not-exist',
    '--main-ref', 'HEAD',
    '--candidate-registry-ref', 'HEAD',
  ]);

  assertFailure(result, /shallow repository/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /cannot resolve tag/i);
});
