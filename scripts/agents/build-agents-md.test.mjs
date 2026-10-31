import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildAgentsMd, CODEX_SECTION_PATH } from './build-agents-md.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

const claudeMd = read('CLAUDE.md');
const codexSection = read(CODEX_SECTION_PATH);
const built = buildAgentsMd(claudeMd, codexSection);
// The shared rules, without the appended Codex section (which names `codex exec` on purpose).
const shared = built.slice(0, built.indexOf(codexSection.trim()));

test('committed AGENTS.md matches what CLAUDE.md builds (run `pnpm agents-md` to regenerate)', () => {
  assert.equal(read('AGENTS.md'), built);
});

test('every CLAUDE.md section except Claude-only ones carries over', () => {
  const headings = claudeMd.match(/^#{2,3} .+$/gm);
  for (const heading of headings) {
    if (heading.startsWith('## Feature Lifecycle Tracking')) continue;
    assert.ok(built.includes(`${heading}\n`), `missing section: ${heading}`);
  }
});

test('Claude-only instructions are removed', () => {
  assert.doesNotMatch(built, /Claude Context/);
  assert.doesNotMatch(built, /Feature Lifecycle Tracking|feature-lifecycle/);
  assert.doesNotMatch(shared, /codex exec/);
  assert.doesNotMatch(built, /delegating-to-codex/);
  assert.doesNotMatch(built, /` skill\b/);
  assert.doesNotMatch(built, /--squash --admin/);
});

test('skill pointers become file paths that exist', () => {
  const paths = [...shared.matchAll(/`(\.claude\/skills\/[^`]+)`/g)].map((m) => m[1]);
  assert.ok(paths.length > 0);
  for (const path of paths) assert.ok(existsSync(`${root}${path}`), `${path} does not exist`);
});

test('the Codex section is appended once, after the shared rules', () => {
  assert.ok(built.startsWith('# Breeze RMM - Agent Context\n'));
  assert.equal(built.split(codexSection.trim()).length, 2);
  assert.ok(built.indexOf('## PR Merge & Deploy') < built.indexOf(codexSection.trim()));
});

test('a CLAUDE.md edit that moves a rewritten line fails loudly instead of leaking into AGENTS.md', () => {
  const edited = claudeMd.replace('get an independent `codex exec` opinion', 'ask codex exec');
  assert.throws(() => buildAgentsMd(edited, codexSection), /expected exactly one match/);
});

test('CI runs this check', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts['test:agents-md'], 'node --test scripts/agents/build-agents-md.test.mjs');
  assert.match(read('.github/workflows/ci.yml'), /run: pnpm test:agents-md/);
});
