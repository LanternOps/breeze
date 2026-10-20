#!/usr/bin/env node
/**
 * check-scan.mjs — gate for the built-in YARA pack's clean-corpus run (#6263 W03b).
 *
 *   node check-scan.mjs <scan.jsonl> <exit-code> <min-files-scanned> <max-failed-ratio>
 *
 * Reads `breeze-yarac scan` output (one JSON line per match, then a summary
 * line) and fails when:
 *   - any rule matched a file of the clean corpus (prints rule + file; the fix
 *     is a denylist.txt entry with that file as the reason);
 *   - the summary line is missing, or reports an error / non-zero exit;
 *   - fewer than <min-files-scanned> files were scanned. A run that scanned
 *     nothing (bad path, everything unreadable) must never read as "no false
 *     positives";
 *   - more than <max-failed-ratio> of the files the scanner reached could not
 *     be scanned (filesFailed). Files a rule makes the engine choke on are
 *     counted as failed, not matched — a partial failure must not read as
 *     clean either.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkScan(text, exitCode, minFiles, maxFailedRatio) {
  const failures = [];
  const matches = [];
  let summary = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // The agent's slog text handler shares stdout ("time=… level=… msg=…").
    if (/^time=\S+ level=[A-Z]+ /.test(line)) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      failures.push(`unparseable output line: ${line.slice(0, 200)}`);
      continue;
    }
    if (obj && typeof obj.ruleName === 'string') matches.push(obj);
    else if (obj && typeof obj.filesScanned === 'number') summary = obj;
    else failures.push(`unexpected output line: ${line.slice(0, 200)}`);
  }
  for (const m of matches) {
    failures.push(`FALSE POSITIVE: rule ${m.ruleName} matched ${m.path} — add "${m.ruleName}  matched ${m.path}" to scripts/security/yara-pack/denylist.txt and bump pack.lock`);
  }
  if (!summary) {
    failures.push('no summary line: the scan did not finish');
  } else {
    if (summary.error) failures.push(`scan error: ${summary.error}`);
    if (summary.engine !== 'yara') failures.push(`engine is ${summary.engine}, not yara`);
    if (summary.matches !== matches.length) failures.push(`summary reports ${summary.matches} matches but ${matches.length} match lines were printed`);
    if (summary.filesScanned < minFiles) failures.push(`only ${summary.filesScanned} files scanned (floor ${minFiles}) — the corpus run is not meaningful`);
    const failed = Number.isInteger(summary.filesFailed) && summary.filesFailed >= 0 ? summary.filesFailed : null;
    if (failed === null) {
      failures.push('summary has no filesFailed count');
    } else {
      const reached = summary.filesScanned + failed;
      const ratio = reached > 0 ? failed / reached : 1;
      if (ratio > maxFailedRatio) {
        failures.push(`${failed} of ${reached} files could not be scanned (${(ratio * 100).toFixed(2)}% > ${(maxFailedRatio * 100).toFixed(2)}%) — unscanned files are not clean`);
      }
    }
  }
  if (exitCode !== 0) failures.push(`breeze-yarac scan exited ${exitCode}`);
  return { ok: failures.length === 0, failures, summary, matches: matches.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, exitArg, minArg, ratioArg] = process.argv.slice(2);
  const minFiles = Number(minArg);
  const maxFailedRatio = Number(ratioArg);
  if (!file || exitArg === undefined || !Number.isInteger(minFiles) || minFiles < 1
      || !Number.isFinite(maxFailedRatio) || maxFailedRatio < 0 || maxFailedRatio >= 1) {
    console.error('usage: check-scan.mjs <scan.jsonl> <exit-code> <min-files-scanned >= 1> <max-failed-ratio in [0,1)>');
    process.exit(2);
  }
  const res = checkScan(readFileSync(file, 'utf8'), Number(exitArg), minFiles, maxFailedRatio);
  if (res.summary) console.log(`summary: ${JSON.stringify(res.summary)}`);
  for (const f of res.failures) console.log(`::error::${f}`);
  process.exit(res.ok ? 0 : 1);
}
