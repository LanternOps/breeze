import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function absolute(relativePath) {
  return path.join(repoRoot, relativePath);
}

function read(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('retired AI documentation automation is absent', () => {
  const retiredPaths = [
    '.github/workflows/doc-verify.yml',
    '.github/workflows/docs-review.yml',
    'docker-compose.doc-verify.yml',
    'e2e-tests/doc-verify',
    'scripts/docs-review/review.mjs',
  ];

  for (const retiredPath of retiredPaths) {
    assert.equal(
      existsSync(absolute(retiredPath)),
      false,
      `${retiredPath} must remain retired`,
    );
  }
});

test('no GitHub workflow injects the repository Anthropic key', () => {
  const workflowDir = absolute('.github/workflows');
  const workflowFiles = readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/u.test(name));

  for (const workflowFile of workflowFiles) {
    assert.doesNotMatch(
      read(path.join('.github/workflows', workflowFile)),
      /ANTHROPIC_API_KEY/u,
      `${workflowFile} must not reference ANTHROPIC_API_KEY`,
    );
  }
});

test('e2e package has no documentation verifier entrypoint or Anthropic dependency', () => {
  const e2ePackage = readJson('e2e-tests/package.json');
  const scripts = e2ePackage.scripts ?? {};
  const dependencies = e2ePackage.dependencies ?? {};

  for (const scriptName of ['doc-verify', 'doc-verify:extract', 'doc-verify:run']) {
    assert.equal(scripts[scriptName], undefined, `${scriptName} must remain absent`);
  }
  assert.equal(
    dependencies['@anthropic-ai/sdk'],
    undefined,
    '@anthropic-ai/sdk must not be a direct e2e dependency',
  );
});

test('manual documentation inventory remains available', () => {
  assert.equal(existsSync(absolute('scripts/docs-review/mapping.json')), true);
  assert.equal(existsSync(absolute('scripts/docs-review/last-reviewed.json')), true);
});

test('Docs CI keeps its check identity and runs deterministic validation', () => {
  const docsWorkflow = read('.github/workflows/docs-ci.yml');
  const docsPackage = readJson('apps/docs/package.json');

  assert.match(docsWorkflow, /^name: Docs CI$/mu);
  assert.match(docsWorkflow, /^\s+name: CI Success$/mu);
  assert.match(docsWorkflow, /pnpm --filter @breeze\/docs check/u);
  assert.match(docsWorkflow, /pnpm --filter @breeze\/docs build/u);
  assert.equal(docsPackage.scripts?.check, 'astro check');
  assert.equal(docsPackage.scripts?.build, 'astro build');
});
