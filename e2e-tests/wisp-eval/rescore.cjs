#!/usr/bin/env node
// Re-score a saved report against the CURRENT scenarios/*.json, with no model calls.
//
//   node rescore.cjs .state/reports/run-<ts>.json [--only id,id]
//
// Use it to tune a check against real observations, and to prove a guard can fail:
// doctor one expectation in a scenario file, re-score, see it go red, restore the file.
// Only checks are re-evaluated; steps are not replayed, so a changed step list needs a real run.
// An sql_equals check whose SQL text changed shows "query was not run": SQL results are
// stored per query text, so a new query needs a real run too.
const fs = require('fs');
const path = require('path');
const { scoreScenario, bucketFor, summarize, markdownTable, validateScenario } = require('./score.cjs');

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: node rescore.cjs <report.json> [--only id,id]'); process.exit(2); }
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const onlyIdx = rest.indexOf('--only');
const only = onlyIdx >= 0 ? rest[onlyIdx + 1].split(',') : null;
const dir = path.join(__dirname, 'scenarios');
const byId = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).map((s) => [s.id, s]));

const results = [];
for (const r of report.results) {
  if (only && !only.includes(r.id)) continue;
  const sc = byId[r.id];
  if (!sc) { console.error(`skip ${r.id}: no scenario file`); continue; }
  const errs = validateScenario(sc);
  if (errs.length) { console.error(errs.join('\n')); process.exit(2); }
  if (!r.observed) { console.error(`skip ${r.id}: report has no observed data (made before rescore support)`); continue; }
  const score = scoreScenario(sc, r.observed);
  const runError = r.observed.error || (score.inconclusive ? 'precondition failed (inconclusive)' : null);
  const bucket = bucketFor(sc.expect, score.passed, runError);
  results.push({ ...r, expect: sc.expect, bucket, checks: score.checks, error: runError, was: r.bucket });
}
const summary = summarize(results);
console.log(markdownTable({ results, summary }));
for (const r of results) {
  const failed = r.checks.filter((x) => !x.ok);
  if (r.bucket === r.was && !failed.length) continue;
  console.log(`\n${r.id}: ${r.was === r.bucket ? r.bucket : `${r.was} -> ${r.bucket}`}`);
  for (const c of failed) console.log(`  FAIL ${c.precondition ? '[pre] ' : ''}${c.kind}${c.step ? ' @' + c.step : ''}: expected ${c.expected}; observed ${String(c.observed).slice(0, 200)}${c.detail ? ` (${c.detail})` : ''}`);
}
process.exit(summary.exitCode);
