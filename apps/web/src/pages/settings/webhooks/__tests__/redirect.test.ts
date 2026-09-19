import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

it('redirects to /integrations#webhooks', () => {
  const src = readFileSync(resolve(__dirname, '../index.astro'), 'utf-8');
  expect(src).toMatch(/Astro\.redirect\(['"]\/integrations#webhooks['"]/);
});
