import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('bootstrap admin production examples', () => {
  it('do not document a non-empty default bootstrap admin password', () => {
    for (const path of ['.env.example', 'deploy/.env.example']) {
      const content = readRepoFile(path);
      const activePasswordAssignments = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('BREEZE_BOOTSTRAP_ADMIN_PASSWORD='));

      expect(activePasswordAssignments, path).toEqual(['BREEZE_BOOTSTRAP_ADMIN_PASSWORD=']);
    }
  });

  it('do not advertise the development bootstrap credential in production docs', () => {
    for (const path of ['README.md', 'docs/DEPLOY_PRODUCTION.md']) {
      const content = readRepoFile(path);

      expect(content, path).not.toContain('BreezeAdmin123!');
      expect(content, path).not.toMatch(/admin@breeze\.local\s*\/\s*/);
    }
  });
});
