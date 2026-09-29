import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '@breeze/shared';

const currentDir = dirname(fileURLToPath(import.meta.url));
const docsPath = join(currentDir, '../../../../../docs/src/content/docs/features/time-sync.mdx');
const sidebarPath = join(currentDir, '../../../../../docs/astro.config.mjs');

it('documents every visibility finding, the UTC rule and sidebar entry', () => {
  const docs = readFileSync(docsPath, 'utf8');
  for (const code of TIME_SYNC_FINDING_CODES.filter(
    (c) => !c.startsWith('policy_'),
  ))
    expect(docs).toContain(code);
  expect(docs).toContain('UTC');
  expect(docs).toContain('Etc/UTC');
  expect(docs).toContain('90 minutes');
  expect(docs).toContain('agent update');
  const sidebar = readFileSync(sidebarPath, 'utf8');
  expect(sidebar).toContain(
    "{ slug: 'features/time-sync' }",
  );
});
