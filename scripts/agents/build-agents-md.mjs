#!/usr/bin/env node
// Builds AGENTS.md (read by Codex and other agents) from CLAUDE.md so both
// harnesses follow one set of rules. CLAUDE.md is the source; AGENTS.md is
// generated and checked in. Claude-only parts are dropped or rewritten here,
// and docs/agents/agents-md-codex.md is appended.
//
//   node scripts/agents/build-agents-md.mjs          # regenerate AGENTS.md
//   node scripts/agents/build-agents-md.mjs --check  # exit 1 if AGENTS.md is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CODEX_SECTION_PATH = 'docs/agents/agents-md-codex.md';

const NOTICE =
  '<!-- Generated from CLAUDE.md by scripts/agents/build-agents-md.mjs. Do not edit by hand: edit CLAUDE.md (shared rules) or docs/agents/agents-md-codex.md (Codex-only rules), then run `pnpm agents-md`. -->';

// Each rewrite must match exactly once, so a CLAUDE.md edit that moves one of
// these lines fails the build instead of leaking a Claude-only rule.
const REWRITES = [
  ['# Breeze RMM - Claude Context\n', `# Breeze RMM - Agent Context\n\n${NOTICE}\n`],
  [
    '| Choosing a model or delegating to Codex/Laguna | `docs/agents/model-routing.md` (`delegating-to-codex` skill) |',
    '| Choosing a model | `docs/agents/model-routing.md` |',
  ],
  [
    'get an independent `codex exec` opinion at `xhigh` (read-only)',
    'get an independent read-only opinion from a second model (e.g. `claude -p`)',
  ],
  [/\n## Feature Lifecycle Tracking[^\n]*\n[\s\S]*?(?=\n## )/, ''],
];

function replaceOnce(text, pattern, replacement) {
  const count =
    typeof pattern === 'string'
      ? text.split(pattern).length - 1
      : (text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? []).length;
  if (count !== 1) {
    throw new Error(`build-agents-md: expected exactly one match for ${String(pattern).slice(0, 80)}, found ${count}`);
  }
  return text.replace(pattern, replacement);
}

export function buildAgentsMd(claudeMd, codexSection) {
  let out = claudeMd;
  for (const [pattern, replacement] of REWRITES) out = replaceOnce(out, pattern, replacement);
  // `name` skill → the skill's file, which any agent can read.
  out = out.replace(/`([a-z0-9-]+)` skill\b/g, '`.claude/skills/$1/SKILL.md`');
  return `${out.trimEnd()}\n\n${codexSection.trim()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const built = buildAgentsMd(
    readFileSync(`${root}CLAUDE.md`, 'utf8'),
    readFileSync(`${root}${CODEX_SECTION_PATH}`, 'utf8'),
  );
  if (process.argv.includes('--check')) {
    if (readFileSync(`${root}AGENTS.md`, 'utf8') !== built) {
      console.error('AGENTS.md is stale. Run `pnpm agents-md` and commit the result.');
      process.exit(1);
    }
  } else {
    writeFileSync(`${root}AGENTS.md`, built);
  }
}
