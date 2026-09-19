import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

it('ticket-checklist-templates.astro redirects into the Ticketing hub Templates tab', () => {
  const src = readFileSync(resolve(__dirname, '../ticket-checklist-templates.astro'), 'utf-8');
  expect(src).toMatch(/Astro\.redirect\(['"]\/settings\/ticketing#templates['"]/);
});
