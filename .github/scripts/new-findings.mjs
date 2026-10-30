// Dependency-audit comparison for CI Success (W1, #10744).
//
// An advisory published overnight against a package already on main used to
// fail `security-audit` on every queued PR at once (3 merge-queue ejections in
// one sampled week, e.g. zod GHSA-mrhx-c7xc-m3w5), though no PR caused it.
// ci.yml's security-audit now runs scripts/security/check-npm-audit.sh with
// --findings-json on the base lockfile + base exceptions file and on the head,
// and this script blocks only on what the change introduces:
//   - a blocking finding (at/above threshold, or unrankable/malicious, and not
//     excepted) on head whose key is not on base → error, exit 1;
//   - a blocking finding on both → warning, not a failure (main surfaces it:
//     security.yml's daily npm-audit opens a tracking issue);
//   - an expired / out-of-policy exception on head → error only with
//     --exceptions-touched (the change edited the exceptions file), else warning.
// Scan integrity is NOT judged here: check-npm-audit.sh writes its findings
// document only after every integrity check passed, and the workflow treats a
// missing document as a hard failure. A document this script cannot read or
// validate exits 2 — never a pass.
//
// Finding: { id, pkg, version, ecosystem }; key `ecosystem|pkg|version|id`, so
// the same advisory on the same package at a different version is new.
//
// CLI:
//   node new-findings.mjs --base <file> --head <file> [--exceptions-touched]
//   node new-findings.mjs --table <file>    # markdown table (security.yml issue)

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 1;
const PROBLEM_STATUSES = new Set(['EXPIRED', 'TOO_FAR']);

class UsageError extends Error {}

const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

function assertDoc(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('findings document must be a JSON object');
  if (json.schema !== SCHEMA) throw new Error(`findings document schema must be ${SCHEMA}, got ${JSON.stringify(json.schema)}`);
  if (!Array.isArray(json.findings)) throw new Error('findings document has no "findings" array');
  if (!Array.isArray(json.exceptionProblems)) throw new Error('findings document has no "exceptionProblems" array');
  json.findings.forEach((x, i) => {
    if (x === null || typeof x !== 'object') throw new Error(`findings[${i}] must be an object`);
    for (const k of ['package', 'version', 'ecosystem', 'id', 'severity']) {
      if (!nonEmpty(x[k])) throw new Error(`findings[${i}].${k} must be a non-empty string`);
    }
    for (const k of ['excepted', 'blocking']) {
      if (typeof x[k] !== 'boolean') throw new Error(`findings[${i}].${k} must be a boolean`);
    }
  });
  json.exceptionProblems.forEach((x, i) => {
    if (x === null || typeof x !== 'object') throw new Error(`exceptionProblems[${i}] must be an object`);
    for (const k of ['id', 'package', 'expires']) {
      if (!nonEmpty(x[k])) throw new Error(`exceptionProblems[${i}].${k} must be a non-empty string`);
    }
    if (!PROBLEM_STATUSES.has(x.status)) throw new Error(`exceptionProblems[${i}].status must be EXPIRED or TOO_FAR`);
  });
  return json;
}

export const findingKey = (f) => `${f.ecosystem}|${f.pkg}|${f.version}|${f.id}`;

// The blocking findings of a check-npm-audit.sh --findings-json document,
// deduplicated and sorted by key. Excepted and below-threshold findings never
// block a run, so they are not compared. Throws on a malformed document.
export function normalize(tool, json) {
  if (tool !== 'osv') throw new Error(`unknown tool ${JSON.stringify(tool)} (expected "osv")`);
  const doc = assertDoc(json);
  const byKey = new Map();
  for (const x of doc.findings) {
    if (!x.blocking) continue;
    const f = { id: x.id, pkg: x.package, version: x.version, ecosystem: x.ecosystem };
    byKey.set(findingKey(f), f);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, f]) => f);
}

// Head findings whose key is not among the base findings.
export function newFindings(base, head) {
  const seen = new Set(base.map(findingKey));
  return head.filter((f) => !seen.has(findingKey(f)));
}

// Expired / out-of-policy exception entries of a document.
export function exceptionProblems(json) {
  return assertDoc(json).exceptionProblems.map(({ id, package: pkg, expires, status }) => ({ id, package: pkg, expires, status }));
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

// Markdown: the document's blocking findings, then its exception problems.
export function findingsTable(json) {
  const doc = assertDoc(json);
  const blocking = doc.findings.filter((x) => x.blocking);
  const lines = [];
  if (blocking.length) {
    lines.push('| Package | Version | Advisory | Severity |', '| --- | --- | --- | --- |');
    for (const x of blocking) lines.push(`| ${cell(x.package)} | ${cell(x.version)} | ${cell(x.id)} | ${cell(x.severity)} |`);
  } else {
    lines.push('No blocking advisories.');
  }
  if (doc.exceptionProblems.length) {
    lines.push('', 'Exceptions out of policy (`scripts/security/npm-audit-exceptions.json`):', '');
    for (const p of doc.exceptionProblems) lines.push(`- ${cell(p.status)} ${cell(p.id)} on ${cell(p.package)} (expires ${cell(p.expires)})`);
  }
  return `${lines.join('\n')}\n`;
}

// --- CLI ---------------------------------------------------------------------

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const label = (f) => `${f.pkg}@${f.version} ${f.id} (${f.ecosystem})`;

function parseCli(argv) {
  const opts = { exceptionsTouched: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exceptions-touched') {
      opts.exceptionsTouched = true;
    } else if (a === '--base' || a === '--head' || a === '--table') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError(`${a} requires a file`);
      opts[a.slice(2)] = v;
    } else {
      throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (opts.table !== undefined) {
    if (opts.base !== undefined || opts.head !== undefined) throw new UsageError('--table takes no --base/--head');
  } else if (opts.base === undefined || opts.head === undefined) {
    throw new UsageError('--base and --head are both required');
  }
  return opts;
}

const readDoc = (path) => assertDoc(JSON.parse(readFileSync(path, 'utf8')));

function main(argv) {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(
      `new-findings: ${e.message}\nusage: new-findings.mjs --base <file> --head <file> [--exceptions-touched] | --table <file>\n`,
    );
    return 2;
  }

  let baseDoc;
  let headDoc;
  try {
    if (opts.table !== undefined) {
      process.stdout.write(findingsTable(readDoc(opts.table)));
      return 0;
    }
    baseDoc = readDoc(opts.base);
    headDoc = readDoc(opts.head);
  } catch (e) {
    process.stdout.write(`::error title=Dependency audit comparison failed::${escapeData(`unusable findings document: ${e.message}`)}\n`);
    return 2;
  }

  const base = normalize('osv', baseDoc);
  const head = normalize('osv', headDoc);
  const added = newFindings(base, head);
  const baseKeys = new Set(base.map(findingKey));
  const existing = head.filter((f) => baseKeys.has(findingKey(f)));
  const problems = exceptionProblems(headDoc);
  const problemsBlock = opts.exceptionsTouched && problems.length > 0;

  for (const f of added) {
    process.stdout.write(`::error title=New advisory::${escapeData(`${label(f)} is introduced by this change — upgrade it, or add a reviewed entry to scripts/security/npm-audit-exceptions.json`)}\n`);
  }
  for (const f of existing) {
    process.stdout.write(`::warning title=Advisory already on base::${escapeData(`${label(f)} is also on the base commit, so it does not block this change; main's daily audit tracks it`)}\n`);
  }
  for (const p of problems) {
    const msg = `${p.status} exception ${p.id} on ${p.package} (expires ${p.expires}) in scripts/security/npm-audit-exceptions.json`;
    const level = problemsBlock ? 'error' : 'warning';
    const why = problemsBlock ? 'this change edits that file, so it must leave it in policy' : 'not blocking: this change does not edit that file';
    process.stdout.write(`::${level} title=Exception out of policy::${escapeData(`${msg} — ${why}`)}\n`);
  }

  const failed = added.length > 0 || problemsBlock;
  process.stdout.write(
    `new-findings: ${added.length} new, ${existing.length} already on base, ${problems.length} exception(s) out of policy${problemsBlock ? ' (blocking: exceptions file touched)' : ''} → ${failed ? 'FAIL' : 'PASS'}\n`,
  );

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = (list) => ['| Package | Version | Advisory |', '| --- | --- | --- |', ...list.map((f) => `| ${cell(f.pkg)} | ${cell(f.version)} | ${cell(f.id)} |`)];
    const md = ['### Dependency audit: base vs head', ''];
    md.push(`**${failed ? 'Blocked' : 'Passed'}** — ${added.length} new, ${existing.length} already on base, ${problems.length} exception(s) out of policy.`, '');
    if (added.length) md.push('New on this change (blocking):', '', ...rows(added), '');
    if (existing.length) md.push('Already on base (not blocking this change):', '', ...rows(existing), '');
    if (problems.length) {
      md.push(`Exceptions out of policy (${problemsBlock ? 'blocking — this change edits the exceptions file' : 'warning only'}):`, '');
      for (const p of problems) md.push(`- ${cell(p.status)} ${cell(p.id)} on ${cell(p.package)} (expires ${cell(p.expires)})`);
      md.push('');
    }
    appendFileSync(summary, `${md.join('\n')}\n`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
