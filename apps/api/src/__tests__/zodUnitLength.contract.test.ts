/**
 * CONTRACT TEST — string length limits that mirror a non-code-point sink are
 * pinned to that sink's unit (#9976).
 *
 * zod 4.6 counts `z.string().max(N)` / `.min(N)` / `.length(N)` in Unicode code
 * points. That matches Postgres `varchar(N)`/`text` (character counts), so most
 * limits need nothing. It does NOT match a Go agent `len()` guard (UTF-8 bytes),
 * a Windows wide-char buffer, or a rule a migration emulates in UTF-16 units:
 * there `.max(N)` admits up to 4N bytes / 2N units. Those limits carry
 * `utf8MaxBytes(N)` / `utf16Max(N)` from @breeze/shared
 * (packages/shared/src/validators/unitLength.ts).
 *
 * Three checks, over non-test files in apps/api/src and
 * packages/shared/src/validators:
 *   1. PINNED — every reviewed sink-bound field still carries its helper.
 *   2. Discovery — a `z.string()…max(N)`/`.length(N)` chain whose comments name
 *      a byte / UTF-16 / Go-agent sink (see SINK_MARKER) must carry a helper or
 *      be in REVIEWED_CODE_POINT_OK with the reason code points are right.
 *      Stale entries fail. This is how a new mirrored limit gets caught: the
 *      repo convention is to say what a limit mirrors next to it.
 *   3. The detector itself, on synthetic source, so the scan cannot pass
 *      vacuously.
 *
 * Keys are `<repo path>::<property or variable name>`, never line numbers.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOTS = ['apps/api/src', 'packages/shared/src/validators'];

/** Comment text that says a limit is measured by something other than code points. */
const SINK_MARKER = /\butf-?8\b|\butf-?16\b|\bwchar|\bbytes?\b|\bGo\b|\blen\(\)|\.go\b|agent\/internal\//i;
const HELPER = /\b(utf8MaxBytes|utf16Max)\(/;

/** Reviewed sink-bound fields: each must keep a unit helper on its length chain. */
const PINNED: Record<string, string> = {
  'apps/api/src/services/softwareActionPayload.ts::name': 'agent validateSoftwareName: Go len() <= 200 bytes',
  'apps/api/src/services/softwareActionPayload.ts::version': 'agent validateSoftwareVersion: Go len() <= 100 bytes',
  'apps/api/src/services/aiToolSchemas.ts::query': 'agent event_logs_query: XPath <= 4096 bytes',
  'apps/api/src/routes/sensitiveData.ts::suppressFilePathRegex': 'agent skips a suppression regex over 512 bytes',
  'packages/shared/src/validators/topologyConfiguration.ts::path': 'agent https target path <= 2048 bytes',
  'packages/shared/src/validators/softwareDetection.ts::serviceName': 'agent service name <= 256 bytes',
  'packages/shared/src/validators/index.ts::packageId': 'ring app-rules backfill SQL measures UTF-16 units',
  'packages/shared/src/validators/index.ts::displayName': 'ring app-rules backfill SQL measures UTF-16 units',
  'packages/shared/src/validators/index.ts::pinnedVersion': 'ring app-rules backfill SQL measures UTF-16 units',
};

/** Discovered by SINK_MARKER, reviewed: code points are the right unit. */
const REVIEWED_CODE_POINT_OK: Record<string, string> = {
  'apps/api/src/routes/agents/schemas.ts::signedInUpns':
    'inbound agent report; the agent caps at 320 bytes, so anything it sends fits 320 code points',
  'apps/api/src/routes/agents/schemas.ts::attemptedAt': 'inbound agent clock string, parsed at ingest',
  'apps/api/src/routes/agents/schemas.ts::eventId': 'inbound; bounds device_event_logs.event_id varchar(100), which counts characters',
  'apps/api/src/routes/agents/schemas.ts::message': 'inbound; server-side abuse bound on a text column',
  'apps/api/src/routes/partnerApi/schemas.ts::deviceHostname': 'response schema over a varchar(255) value; 2x is headroom',
  'apps/api/src/services/aiToolSchemas.ts::processName': 'display-only approval label; never reaches the agent',
};

interface Site { key: string; line: number; pinned: boolean; marked: boolean }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__fixtures__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every z.string() method chain in `source` that is length-bounded (`.max()` /
 * `.length()`) or carries a unit helper, one site per chain.
 */
export function stringLengthSites(source: string, file: string): Site[] {
  if (!/\.(max|length)\(|utf8MaxBytes\(|utf16Max\(/.test(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];
  const isCallee = (child: ts.Node, parent: ts.Node) =>
    (ts.isPropertyAccessExpression(parent) || ts.isCallExpression(parent)) && parent.expression === child;
  const comments = (node: ts.Node) => {
    const leading = (ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []).map((r) => source.slice(r.pos, r.end));
    const inner = node.getText(sf).match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
    return [...leading, ...inner].join('\n');
  };
  const visit = (node: ts.Node) => {
    // A chain top: a call whose result is not itself the receiver of another call.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && !(node.parent && isCallee(node, node.parent))) {
      const methods: string[] = [];
      let bounded = false;
      let pinned = false;
      let cur: ts.Expression = node;
      for (;;) {
        if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          const name = cur.expression.name.text;
          methods.push(name);
          if ((name === 'max' || name === 'length') && cur.arguments.length > 0) bounded = true;
          if (name === 'check' && cur.arguments.some((arg) => HELPER.test(arg.getText(sf)))) pinned = true;
          cur = cur.expression.expression;
          continue;
        }
        if (ts.isPropertyAccessExpression(cur)) { methods.push(cur.name.text); cur = cur.expression; continue; }
        break;
      }
      if (ts.isIdentifier(cur) && cur.text === 'z' && methods[methods.length - 1] === 'string' && (bounded || pinned)) {
        let anchor: ts.Node | undefined = node;
        let key = '<anonymous>';
        while (anchor) {
          if (ts.isPropertyAssignment(anchor)) { key = anchor.name.getText(sf).replace(/['"]/g, ''); break; }
          if (ts.isVariableStatement(anchor)) { key = anchor.declarationList.declarations[0]!.name.getText(sf); break; }
          anchor = anchor.parent;
        }
        sites.push({
          key,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          pinned,
          marked: SINK_MARKER.test(comments(anchor ?? node)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function scan(): Map<string, Site[]> {
  const out = new Map<string, Site[]>();
  for (const root of ROOTS) {
    for (const path of sourceFiles(join(REPO, root))) {
      const file = relative(REPO, path);
      for (const site of stringLengthSites(readFileSync(path, 'utf8'), file)) {
        const key = `${file}::${site.key}`;
        out.set(key, [...(out.get(key) ?? []), site]);
      }
    }
  }
  return out;
}

describe('zod string limits pinned to their sink unit (#9976)', () => {
  const sites = scan();

  it('scans the real tree', () => {
    // A broken walker would find nothing and pass every check below.
    expect([...sites.values()].flat().length).toBeGreaterThan(1000);
  });

  it.each(Object.keys(PINNED))('%s still carries a unit helper', (key) => {
    const found = sites.get(key);
    expect(found, `${key} has no z.string() length chain any more; update PINNED`).toBeDefined();
    expect(found!.some((s) => s.pinned), `${key} lost utf8MaxBytes/utf16Max (${PINNED[key]})`).toBe(true);
  });

  it('every sink-marked limit is pinned or reviewed', () => {
    const unpinned = [...sites.entries()]
      .flatMap(([key, list]) => list.filter((s) => s.marked && !s.pinned).map((s) => ({ key, line: s.line })))
      .filter(({ key }) => !(key in REVIEWED_CODE_POINT_OK));
    expect(
      unpinned,
      'These length limits sit next to a comment naming a byte / UTF-16 / Go-agent sink. zod 4.6 counts .max() in code '
      + 'points. Add .check(utf8MaxBytes(N)) or .check(utf16Max(N)) from @breeze/shared, or add the key to '
      + 'REVIEWED_CODE_POINT_OK with the reason code points are right (e.g. a varchar column).',
    ).toEqual([]);
  });

  it('has no stale reviewed entries', () => {
    const stale = Object.keys(REVIEWED_CODE_POINT_OK).filter((key) => !(sites.get(key) ?? []).some((s) => s.marked && !s.pinned));
    expect(stale, 'No longer discovered as an unpinned sink-marked limit; remove from REVIEWED_CODE_POINT_OK').toEqual([]);
  });
});

describe('stringLengthSites detector', () => {
  const detect = (source: string) => stringLengthSites(source, 'fixture.ts');

  it('flags an unpinned limit next to a byte-sink comment', () => {
    expect(detect(`const s = z.object({\n  // the agent caps this at 64 bytes\n  label: z.string().min(1).max(64),\n});`))
      .toEqual([{ key: 'label', line: 3, pinned: false, marked: true }]);
  });

  it('sees a helper anywhere on the chain, before or after .max()', () => {
    expect(detect(`const a = z.object({ x: z.string().max(8).check(utf8MaxBytes(8)) });`)[0]?.pinned).toBe(true);
    expect(detect(`const b = z.object({ x: z.string().check(utf16Max(8)).max(8) });`)[0]?.pinned).toBe(true);
  });

  it('does not borrow a helper from a sibling field', () => {
    const found = detect(`const c = z.object({ a: z.string().max(8), b: z.string().max(8).check(utf8MaxBytes(8)) });`);
    expect(found.map((s) => [s.key, s.pinned])).toEqual([['a', false], ['b', true]]);
  });

  it('ignores non-string bounds and unmarked limits', () => {
    expect(detect(`const d = z.object({ n: z.number().max(5), list: z.array(z.string()).max(5) });`)).toEqual([]);
    expect(detect(`const e = z.object({\n  // display name\n  name: z.string().max(200),\n});`)[0]?.marked).toBe(false);
  });
});
