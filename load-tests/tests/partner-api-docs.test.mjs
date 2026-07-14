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
  assert.match(scenario, /resourceCounts/u);
  assert.match(scenario, /partner_export_checkpoint/u);
  assert.match(scenario, /partner_export_page_duration\{/u);
  assert.match(scenario, /partner_export_traversal_duration\{/u);
  assert.match(scenario, /'custom-field-values'/u);
});

test('partner export supports a changed-row two-phase gate', async () => {
  const config = await read('../config.js');
  const scenario = await read('../scenarios/partner-api-export.js');
  assert.match(config, /PARTNER_API_MODE/u);
  assert.match(config, /INCREMENTAL_UPDATED_SINCE/u);
  assert.match(config, /PARTNER_API_CHECKPOINTS_JSON/u);
  assert.match(config, /INCREMENTAL_PAGE_LIMIT/u);
  assert.match(config, /PARTNER_API_INCREMENTAL_EXPECTED_RECORDS/u);
  assert.match(scenario, /MODE === 'full'/u);
  assert.match(scenario, /MODE === 'incremental'/u);
  assert.match(scenario, /did not exercise a late incremental cursor page/u);
});

test('retained changed-incremental evidence covers every resource and is sanitized', async () => {
  const raw = await read('../evidence/2026-07-14-partner-export-changed-incremental.json');
  const evidence = JSON.parse(raw);
  const resources = Object.keys(evidence.incremental.resourceCounts);
  assert.equal(resources.length, 13);
  for (const resource of resources) {
    assert.ok(evidence.incremental.resourceCounts[resource].pages >= 2, resource);
    assert.ok(evidence.incremental.resourceCounts[resource].records >= 2, resource);
  }
  assert.equal(evidence.incremental.contractFailures, 0);
  assert.equal(evidence.incremental.duplicateRecords, 0);
  assert.equal(evidence.incremental.snapshotChanges, 0);
  assert.ok(evidence.planEvidence.length >= 10);
  for (const plan of evidence.planEvidence) {
    assert.ok(Array.isArray(plan.nodes) && plan.nodes.length > 0);
    assert.ok(Number.isFinite(plan.bufferHits));
    assert.ok(Number.isFinite(plan.bufferReads));
    assert.ok(Number.isFinite(plan.rowsRemoved));
    assert.ok(Number.isFinite(plan.executionMs));
  }
  assert.doesNotMatch(raw, /brz_sp_|localhost|host\.docker\.internal|(?:[0-9a-f]{8}-){1}[0-9a-f-]{27}/iu);
});
