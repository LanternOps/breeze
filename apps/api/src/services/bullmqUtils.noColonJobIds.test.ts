import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guard: no BullMQ custom job id in apps/api/src is spelled with ':'.
 *
 * bullmq 5.x throws `Custom Id cannot contain :` from `queue.add` for any custom
 * jobId containing ':' unless it splits into exactly three parts (a carve-out
 * for legacy repeatable ids that bullmq marks for removal). Nearly every enqueue
 * call site catches and logs, so a bad id does not fail loudly — it silently
 * disables the feature (DNS policy sync, sending-domain auto-suspension, BYO-MCP
 * discovery, BMR file-index hydration, ...). Ids that happen to have exactly
 * three colon-parts pass only until a part contains ':' or bullmq drops the
 * carve-out, so this guard bans ':' outright. Build ids with `bullmqJobId(...)`
 * (services/bullmqUtils.ts) or join with '-'.
 *
 * Shapes checked (the static text of the literal, `${...}` interpolations
 * excluded so a ternary's ':' is not a false positive):
 *   - `jobId: <literal>` option properties
 *   - `const|let <name containing jobId/JobId/JOB_ID> = <literal>`
 *   - `function <name>JobId(...) { return <literal>` and the arrow equivalent
 *   - `[...].join(':')` assigned to a job-id-named binding
 *
 * A literal passed positionally to an add-helper (dnsSyncJob's `addUniqueJob`)
 * cannot be told apart from the many Redis keys and dedupe keys that legitimately
 * use ':' — those sites carry their own id assertions in their module tests.
 */

const SRC_ROOT = join(__dirname, '..');

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Reads the string/template literal starting at `start`; returns its static text and end index. */
function readLiteral(src: string, start: number): { text: string; end: number } | null {
  const quote = src[start];
  if (quote !== '`' && quote !== "'" && quote !== '"') return null;
  let text = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      text += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === quote) return { text, end: i + 1 };
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      // Skip the interpolation, tracking nested braces and literals.
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '`' || c === "'" || c === '"') {
          const inner = readLiteral(src, i);
          i = inner ? inner.end : i + 1;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      text += '${}';
      continue;
    }
    if (quote !== '`' && ch === '\n') return null;
    text += ch;
    i++;
  }
  return null;
}

const JOB_ID_NAME = String.raw`\w*(?:jobId|JobId|JOB_ID)\w*`;
const SHAPES: Array<{ label: string; re: RegExp }> = [
  { label: 'jobId option', re: /\bjobId\s*:\s*(?=[`'"])/g },
  { label: 'job-id binding', re: new RegExp(String.raw`\b(?:const|let|var)\s+${JOB_ID_NAME}\s*(?::\s*string\s*)?=\s*(?=[\x60'"])`, 'g') },
  { label: 'job-id function', re: new RegExp(String.raw`\bfunction\s+${JOB_ID_NAME}\s*\([^)]*\)\s*(?::\s*string\s*)?\{\s*return\s+(?=[\x60'"])`, 'g') },
  { label: 'job-id arrow', re: new RegExp(String.raw`\b${JOB_ID_NAME}\s*=\s*\([^)]*\)\s*(?::\s*string\s*)?=>\s*(?=[\x60'"])`, 'g') },
];
const COLON_JOIN = new RegExp(String.raw`\b(?:const|let|var)\s+${JOB_ID_NAME}\s*=\s*\[[^\]]*\]\s*\.join\(\s*['"\x60]:['"\x60]\s*\)`, 'g');

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function findColonJobIds(): string[] {
  const offenders: string[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!/jobId|JobId|JOB_ID/.test(src)) continue;
    const rel = relative(SRC_ROOT, file);
    for (const { label, re } of SHAPES) {
      re.lastIndex = 0;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const lit = readLiteral(src, m.index + m[0].length);
        if (lit && lit.text.includes(':')) {
          offenders.push(`${rel}:${lineOf(src, m.index)} (${label}) ${src.slice(m.index + m[0].length, lit.end)}`);
        }
      }
    }
    COLON_JOIN.lastIndex = 0;
    for (let m = COLON_JOIN.exec(src); m; m = COLON_JOIN.exec(src)) {
      offenders.push(`${rel}:${lineOf(src, m.index)} (join(':')) ${m[0]}`);
    }
  }
  return offenders;
}

describe('BullMQ custom job ids never contain ":"', () => {
  it('finds no colon-spelled job id in apps/api/src', () => {
    expect(findColonJobIds()).toEqual([]);
  });

  it('control: the scanner sees the job-id shapes it claims to check', () => {
    // Guards against a vacuous pass (e.g. SRC_ROOT pointing at nothing).
    expect(listSourceFiles(SRC_ROOT).length).toBeGreaterThan(500);
    const probe = [
      "add('x', {}, { jobId: `autosuspend:${partnerId}` });",
      'const jobId = `reliability-device:${deviceId}:${slot}`;',
      'function fooJobId(id: string): string {\n  return `hydrate:${id}`;\n}',
      'const barJobId = (id: string) => `discover:${id}`;',
      "const jobId = ['a', b, c].join(':');",
      // not offenders: a ternary inside an interpolation, a '-' id
      "add('x', {}, { jobId: `s1-${a ? 'agents' : 'none'}` });",
      'const jobId = `sync-policy-${policyId}`;',
    ].join('\n');
    const hits: string[] = [];
    for (const { re } of SHAPES) {
      re.lastIndex = 0;
      for (let m = re.exec(probe); m; m = re.exec(probe)) {
        const lit = readLiteral(probe, m.index + m[0].length);
        if (lit && lit.text.includes(':')) hits.push(probe.slice(m.index + m[0].length, lit.end));
      }
    }
    COLON_JOIN.lastIndex = 0;
    if (COLON_JOIN.exec(probe)) hits.push('join');
    expect(hits).toEqual([
      '`autosuspend:${partnerId}`',
      '`reliability-device:${deviceId}:${slot}`',
      '`hydrate:${id}`',
      '`discover:${id}`',
      'join',
    ]);
  });
});
