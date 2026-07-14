import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('partner API key is inherited and never shown as a k6 command argument', async () => {
  const readme = await read('../README.md');
  assert.doesNotMatch(readme, /-e\s+PARTNER_API_KEY\s*=/u);
  assert.match(readme, /inherited `PARTNER_API_KEY` environment variable/u);
});

test('partner export summary preserves per-resource page and traversal evidence', async () => {
  const scenario = await read('../scenarios/partner-api-export.js');
  assert.match(scenario, /resourceDurations/u);
  assert.match(scenario, /partner_export_page_duration\{/u);
  assert.match(scenario, /partner_export_traversal_duration\{/u);
  assert.match(scenario, /'custom-field-values'/u);
});
