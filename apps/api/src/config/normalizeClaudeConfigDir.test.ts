import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeClaudeConfigDir } from './normalizeClaudeConfigDir';

// #9133 / #9044: docker-compose maps `CLAUDE_CONFIG_DIR: ${CLAUDE_CONFIG_DIR:-}`,
// so an operator who leaves it unset hands the API `CLAUDE_CONFIG_DIR=""`.
// Breeze's resolver treats "" as "use ~/.claude"; the Agent SDK derives its
// config dir with `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`, so "" becomes
// the RELATIVE path "projects" and `deleteSession` finds nothing.
describe('normalizeClaudeConfigDir', () => {
  it('removes an empty or whitespace-only CLAUDE_CONFIG_DIR so it reads as unset', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: raw };
      expect(normalizeClaudeConfigDir(env)).toEqual({ changed: true });
      expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    }
  });

  it('leaves a real path and an already-unset variable alone', () => {
    const set: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/data/claude' };
    expect(normalizeClaudeConfigDir(set)).toEqual({ changed: false });
    expect(set.CLAUDE_CONFIG_DIR).toBe('/data/claude');

    const unset: NodeJS.ProcessEnv = {};
    expect(normalizeClaudeConfigDir(unset)).toEqual({ changed: false });
    expect('CLAUDE_CONFIG_DIR' in unset).toBe(false);
  });
});

// Drives the REAL SDK (not a mock) in a child process against a throwaway HOME,
// with the compose-shaped environment CLAUDE_CONFIG_DIR="". A child, because the
// SDK memoizes its config dir on first use and os.homedir() ignores a worker
// thread's process.env.HOME. Control run: without the normalizer import the SDK
// rejects with "Session ... not found in any project directory" (SDK 0.3.296).
describe('SDK deleteSession under CLAUDE_CONFIG_DIR=""', () => {
  const SESSION_ID = '0b6f0f6e-8a1d-4c63-9a55-3f1d2c7b9e10';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tsx = path.resolve(here, '../../node_modules/.bin/tsx');
  const normalizer = path.join(here, 'normalizeClaudeConfigDir.ts');
  let home: string;
  let transcript: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'claude-cfg-'));
    const projectDir = path.join(home, '.claude', 'projects', '-app');
    mkdirSync(projectDir, { recursive: true });
    transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: SESSION_ID })}\n`);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function deleteInChild(withNormalizer: boolean) {
    const script = [
      withNormalizer ? `import ${JSON.stringify(normalizer)};` : '',
      `import { deleteSession } from '@anthropic-ai/claude-agent-sdk';`,
      `try { await deleteSession(${JSON.stringify(SESSION_ID)}); console.log('deleted'); }`,
      `catch (e) { console.log('ERR ' + e.message); }`,
    ].join('\n');
    return spawnSync(tsx, ['--input-type=module', '-e', script], {
      cwd: path.resolve(here, '../..'),
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  it('control: with the empty value left in place the SDK cannot find the transcript', () => {
    const r = deleteInChild(false);
    expect(r.stdout).toMatch(/ERR Session .* not found in any project directory/);
    expect(existsSync(transcript)).toBe(true);
  });

  it('deletes the transcript from ~/.claude/projects once the empty value is normalized away', () => {
    const r = deleteInChild(true);
    expect(r.stdout.trim()).toBe('deleted');
    expect(existsSync(transcript)).toBe(false);
  });
});
