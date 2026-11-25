import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function isIgnored(p: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', p], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('gitignore coverage (#12421)', () => {
  it.each([
    'apps/api/tool-capture.jsonl',
    'apps/api/tool-capture.raw.jsonl',
    'apps/api/tool-eval-report.json',
    'apps/api/tool-eval-summary.md',
    'apps/api/.ai-reports/discovery-2026-11-21.md',
    'apps/api/.ai-reports/candidates/2026-11-21.json',
  ])('%s is ignored', (p) => {
    expect(isIgnored(p)).toBe(true);
  });

  it('a tracked path is not ignored (control)', () => {
    expect(isIgnored('apps/api/package.json')).toBe(false);
  });
});
