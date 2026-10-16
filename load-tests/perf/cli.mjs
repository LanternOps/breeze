#!/usr/bin/env node
// load-tests/perf/cli.mjs — build a KPI record / compare two (scaling W07, #8146).
//   node load-tests/perf/cli.mjs build   --report <agentsim.json> --samples <csv> --idle <csv> --hardware <json> --stack <json> --git-sha <sha> --profile <name> --out <kpi.json>
//   node load-tests/perf/cli.mjs compare --baseline <kpi.json> --candidate <kpi.json> [--confirm <kpi.json>] [--expect regression]
// Exit codes: 0 pass, 1 regression (after --confirm, only if confirmed), 2 invalid run, 64 usage.
// With --expect regression the 0/1 codes swap and the regression must name both
// agentCostCpuMsPerAgentMin and heartbeatP95Ms.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { InvalidRunError, buildKpiRecord, compare, confirm } from './kpi.mjs';

export const SAMPLES_HEADER = 'ts,cpu_seconds,xact_commit,ws_connections,elu,lag_max,pool_waiting,scrape_ok';
const EXPECT_BOTH = ['agentCostCpuMsPerAgentMin', 'heartbeatP95Ms'];

class UsageError extends Error {}

const USAGE = `usage:
  cli.mjs build   --report <agentsim.json> --samples <csv> --idle <csv> --hardware <json> --stack <json> --git-sha <sha> --profile <name> --out <kpi.json>
  cli.mjs compare --baseline <kpi.json> --candidate <kpi.json> [--confirm <kpi.json>] [--expect regression]`;

/** Strict samples-CSV reader; errors name the file and line. NaN is allowed only on scrape_ok=0 rows. */
export function parseSamplesCsv(text, file) {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const where = (n) => `${file}: line ${n}`;
  if (lines[0] !== SAMPLES_HEADER) {
    throw new InvalidRunError(`${where(1)}: unexpected header ${JSON.stringify(lines[0] ?? '')}; want ${SAMPLES_HEADER}`);
  }
  const num = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
  return lines.slice(1).map((line, i) => {
    const n = i + 2;
    const f = line.split(',');
    if (f.length !== 8) throw new InvalidRunError(`${where(n)}: expected 8 fields, got ${f.length}`);
    const ts = new Date(f[0]);
    if (!/^\d{4}-\d\d-\d\dT/.test(f[0]) || Number.isNaN(ts.getTime())) throw new InvalidRunError(`${where(n)}: bad timestamp ${JSON.stringify(f[0])}`);
    if (f[7] !== '0' && f[7] !== '1') throw new InvalidRunError(`${where(n)}: scrape_ok must be 0 or 1, got ${JSON.stringify(f[7])}`);
    const scrapeOk = f[7] === '1';
    const values = f.slice(1, 7).map((v, j) => {
      if (num.test(v)) return Number(v);
      if (v === 'NaN' && !scrapeOk) return Number.NaN;
      throw new InvalidRunError(`${where(n)}: field ${SAMPLES_HEADER.split(',')[j + 1]} is not numeric: ${JSON.stringify(v)}`);
    });
    const [cpuSeconds, xactCommit, wsConnections, elu, lagMax, poolWaiting] = values;
    return { ts, cpuSeconds, xactCommit, wsConnections, elu, lagMax, poolWaiting, scrapeOk };
  });
}

function readFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new InvalidRunError(`cannot read ${file}: ${e.code ?? e.message}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFile(file));
  } catch (e) {
    if (e instanceof InvalidRunError) throw e;
    throw new InvalidRunError(`${file}: invalid JSON (${e.message})`);
  }
}

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
}

function need(values, names) {
  const missing = names.filter((n) => !values[n]);
  if (missing.length) throw new UsageError(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
}

function cmdBuild(argv) {
  const v = parse(argv, {
    report: { type: 'string' },
    samples: { type: 'string' },
    idle: { type: 'string' },
    hardware: { type: 'string' },
    stack: { type: 'string' },
    'git-sha': { type: 'string' },
    profile: { type: 'string' },
    out: { type: 'string' },
  });
  need(v, ['report', 'samples', 'idle', 'hardware', 'stack', 'git-sha', 'profile', 'out']);
  const record = buildKpiRecord({
    report: readJson(v.report),
    samples: parseSamplesCsv(readFile(v.samples), v.samples),
    idle: parseSamplesCsv(readFile(v.idle), v.idle),
    hardware: readJson(v.hardware),
    stack: readJson(v.stack),
    gitSha: v['git-sha'],
    profile: v.profile,
    measuredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sources: { agentsimReport: path.basename(v.report), samples: path.basename(v.samples) },
  });
  writeFileSync(v.out, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`wrote ${v.out}\n`);
  return 0;
}

const fmt = (n) => (n === null || n === undefined ? 'n/a' : String(Number(n.toFixed(3))));
const verdictOf = (r) => (r.regressed ? 'REGRESSION' : r.improved ? 'improved (consider re-baselining)' : 'ok');
const pct = (r) => (r.deltaPct === null ? 'n/a' : `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}`);

function textTable(rows) {
  const head = ['KPI', 'Baseline', 'Candidate', 'Δ %', 'Verdict'];
  const body = rows.map((r) => [r.kpi, fmt(r.baseline), fmt(r.candidate), pct(r), verdictOf(r)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

function markdownTable(rows, finalVerdict, note) {
  const out = ['| KPI | Baseline | Candidate | Δ % | Verdict |', '| --- | ---: | ---: | ---: | --- |'];
  for (const r of rows) out.push(`| ${r.kpi} | ${fmt(r.baseline)} | ${fmt(r.candidate)} | ${pct(r)} | ${verdictOf(r)} |`);
  out.push('', `**Result: ${finalVerdict}**${note ? ` ${note}` : ''}`, '');
  return out.join('\n');
}

function cmdCompare(argv) {
  const v = parse(argv, {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    confirm: { type: 'string' },
    expect: { type: 'string' },
  });
  need(v, ['baseline', 'candidate']);
  if (v.expect !== undefined && v.expect !== 'regression') throw new UsageError(`--expect accepts only "regression", got ${JSON.stringify(v.expect)}`);

  const baseline = readJson(v.baseline);
  const first = compare(baseline, readJson(v.candidate));
  let finalVerdict = first.verdict;
  let regressedKpis = first.rows.filter((r) => r.regressed).map((r) => r.kpi);
  let note = '';
  let confirmText = '';
  if (first.verdict === 'regression' && v.confirm) {
    const second = compare(baseline, readJson(v.confirm));
    const c = confirm(first, second);
    finalVerdict = c.verdict;
    regressedKpis = c.kpis;
    confirmText = `\nConfirm run:\n${textTable(second.rows)}\n`;
    note = c.verdict === 'pass'
      ? '(first run regressed, confirm run did not repeat it)'
      : `(confirmed on ${c.kpis.join(', ')})`;
  }

  const summary = `${textTable(first.rows)}\n${confirmText}\nResult: ${finalVerdict}${regressedKpis.length ? ` (${regressedKpis.join(', ')})` : ''}${note ? ` ${note}` : ''}\n`;
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownTable(first.rows, finalVerdict, note)}\n`);
  }

  if (v.expect === 'regression') {
    const missing = EXPECT_BOTH.filter((k) => !regressedKpis.includes(k));
    if (finalVerdict === 'regression' && missing.length === 0) return 0;
    process.stderr.write(
      finalVerdict === 'regression'
        ? `expected a regression naming ${EXPECT_BOTH.join(' and ')}; missing ${missing.join(', ')}\n`
        : `expected a regression but the gate stayed green\n`,
    );
    return 1;
  }
  return finalVerdict === 'regression' ? 1 : 0;
}

export function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === 'build') return cmdBuild(rest);
    if (cmd === 'compare') return cmdCompare(rest);
    throw new UsageError(cmd ? `unknown subcommand ${JSON.stringify(cmd)}` : 'missing subcommand');
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      return 64;
    }
    if (e instanceof InvalidRunError) {
      process.stderr.write(`invalid run: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
