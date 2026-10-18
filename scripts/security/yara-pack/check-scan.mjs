#!/usr/bin/env node
/**
 * check-scan.mjs — gate for the built-in YARA pack's clean-corpus run (#6263 W03b).
 *
 *   node check-scan.mjs <scan.jsonl> <exit-code> <min-files-scanned>
 *
 * Reads `breeze-yarac scan` output (one JSON line per match, then a summary
 * line) and fails when:
 *   - any rule matched a file of the clean corpus (prints rule + file; the fix
 *     is a denylist.txt entry with that file as the reason);
 *   - the summary line is missing, or reports an error / non-zero exit;
 *   - fewer than <min-files-scanned> files were scanned. A run that scanned
 *     nothing (bad path, everything unreadable) must never read as "no false
 *     positives".
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkScan(text, exitCode, minFiles) {
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
  }
  if (exitCode !== 0) failures.push(`breeze-yarac scan exited ${exitCode}`);
  return { ok: failures.length === 0, failures, summary, matches: matches.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, exitArg, minArg] = process.argv.slice(2);
  if (!file || exitArg === undefined || minArg === undefined) {
    console.error('usage: check-scan.mjs <scan.jsonl> <exit-code> <min-files-scanned>');
    process.exit(2);
  }
  const res = checkScan(readFileSync(file, 'utf8'), Number(exitArg), Number(minArg));
  if (res.summary) console.log(`summary: ${JSON.stringify(res.summary)}`);
  for (const f of res.failures) console.log(`::error::${f}`);
  process.exit(res.ok ? 0 : 1);
}
