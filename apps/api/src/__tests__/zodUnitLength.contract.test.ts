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
 *      Stale entries fail. This is a heuristic: it relies on the repo
 *      convention of saying what a limit mirrors next to it, so an uncommented
 *      mirrored limit, or a schema built from a variable (`base.max(N)`), is
 *      not discovered. PINNED is the hard guard.
 *   3. The detector itself, on synthetic source, so the scan cannot pass
 *      vacuously.
 *
 * Keys are `<repo path>::<variable>.<property path>::<bound>`, never line
 * numbers. The bound is the `.max()`/`.length()` argument, or the helper's
 * first argument on a helper-only chain.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOTS = ['apps/api/src', 'packages/shared/src/validators'];

/** Comment text that says a limit is measured by something other than code points. */
const SINK_MARKER_CI = /\butf-?8\b|\butf-?16\b|\bwchar|\bbytes?\b|\blen\(\)|\.go\b|agent\/internal\//i;
const SINK_MARKER_GO = /\bGo\b/; // case-sensitive: the language, not the verb
const isSinkMarked = (text: string) => SINK_MARKER_CI.test(text) || SINK_MARKER_GO.test(text);
const HELPER = /\b(utf8MaxBytes|utf16Max)\(/;

/** Reviewed sink-bound fields: each must keep a unit helper on its length chain. */
const PINNED: Record<string, string> = {
  'apps/api/src/services/softwareActionPayload.ts::softwareActionPayloadSchema.name::200': 'agent validateSoftwareName: Go len() <= 200 bytes',
  'apps/api/src/services/softwareActionPayload.ts::softwareActionPayloadSchema.version::100': 'agent validateSoftwareVersion: Go len() <= 100 bytes',
  'apps/api/src/services/aiToolSchemas.ts::executeCommandPayloadSchema.query::2000': 'agent event_logs_query: XPath <= 4096 bytes',
  'apps/api/src/routes/sensitiveData.ts::policyScopeSchema.suppressFilePathRegex::300': 'agent skips a suppression regex over 512 bytes',
  'packages/shared/src/validators/topologyConfiguration.ts::topologyTargetDefinitionSchema.path::2048': 'agent https target path <= 2048 bytes',
  'packages/shared/src/validators/softwareDetection.ts::serviceRunningDetectionRuleSchema.serviceName::256': 'agent service name <= 256 bytes',
  'packages/shared/src/validators/index.ts::policyAppRuleSchema.packageId::256': 'ring app-rules backfill SQL measures UTF-16 units',
  'packages/shared/src/validators/index.ts::policyAppRuleSchema.displayName::255': 'ring app-rules backfill SQL measures UTF-16 units',
  'packages/shared/src/validators/index.ts::policyAppRuleSchema.pinnedVersion::64': 'ring app-rules backfill SQL measures UTF-16 units',
};

/** Discovered by SINK_MARKER, reviewed: code points are the right unit. */
const REVIEWED_CODE_POINT_OK: Record<string, string> = {
  'apps/api/src/routes/agents/schemas.ts::heartbeatSchema.onedriveDeviceState.signedInUpns::320':
    'inbound agent report; the agent caps at 320 bytes, so anything it sends fits 320 code points',
  'apps/api/src/routes/agents/schemas.ts::restorePointOutcomeSchema.attemptedAt::64': 'inbound agent clock string, parsed at ingest',
  'apps/api/src/routes/agents/schemas.ts::eventLogRowSchema.eventId::100': 'inbound; bounds device_event_logs.event_id varchar(100), which counts characters',
  'apps/api/src/routes/agents/schemas.ts::eventLogRowSchema.message::2000': 'inbound; server-side abuse bound on a text column',
  'apps/api/src/routes/partnerApi/schemas.ts::partnerAlertExportRecordSchema.deviceHostname::510': 'response schema over a varchar(255) value; 2x is headroom',
  'apps/api/src/services/aiToolSchemas.ts::executeCommandPayloadSchema.processName::255': 'display-only approval label; never reaches the agent',
  'packages/shared/src/validators/systemProtectionInlineSettings.ts::labelPrefixSchema::64':
    'the agent truncates the restore-point description to its [256]uint16 budget itself; 64 code points <= 128 units',
};

interface Site { key: string; bound: string | null; line: number; pinned: boolean; marked: boolean }

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
      let bound: string | null = null;
      let helperBound: string | null = null;
      let pinned = false;
      let cur: ts.Expression = node;
      for (;;) {
        if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          const name = cur.expression.name.text;
          methods.push(name);
          if ((name === 'max' || name === 'length') && cur.arguments.length > 0) bound ??= cur.arguments[0]!.getText(sf);
          for (const arg of name === 'check' ? cur.arguments : []) {
            if (ts.isCallExpression(arg) && HELPER.test(arg.expression.getText(sf) + '(')) {
              pinned = true;
              helperBound ??= arg.arguments[0]?.getText(sf) ?? null;
            }
          }
          cur = cur.expression.expression;
          continue;
        }
        if (ts.isPropertyAccessExpression(cur)) { methods.push(cur.name.text); cur = cur.expression; continue; }
        break;
      }
      // z.string()… or z.coerce.string()…
      const root = methods[methods.length - 1] === 'coerce' ? methods[methods.length - 2] : methods[methods.length - 1];
      if (ts.isIdentifier(cur) && cur.text === 'z' && root === 'string' && (bound !== null || pinned)) {
        // Comments come from the nearest property or variable statement; the key
        // qualifies the property by every enclosing property and the variable
        // (or function) it lives in, so same-named fields in one file differ.
        let anchor: ts.Node | undefined;
        const path: string[] = [];
        for (let n: ts.Node | undefined = node; n; n = n.parent) {
          if (ts.isPropertyAssignment(n)) { path.unshift(n.name.getText(sf).replace(/['"]/g, '')); anchor ??= n; }
          if (ts.isVariableStatement(n)) { path.unshift(n.declarationList.declarations[0]!.name.getText(sf)); anchor ??= n; break; }
          if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) { path.unshift(`${n.name.getText(sf)}()`); break; }
        }
        const key = path.join('.') || '<anonymous>';
        sites.push({
          key,
          bound: bound ?? helperBound,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          pinned,
          marked: isSinkMarked(comments(anchor ?? node)),
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
        const key = `${file}::${site.key}::${site.bound}`;
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
    // Every chain with this name and bound, so a pinned sibling cannot mask an unpinned one.
    expect(found!.every((s) => s.pinned), `${key} lost utf8MaxBytes/utf16Max (${PINNED[key]})`).toBe(true);
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
      .toEqual([{ key: 's.label', bound: '64', line: 3, pinned: false, marked: true }]);
  });

  it('sees a helper anywhere on the chain, before or after .max()', () => {
    expect(detect(`const a = z.object({ x: z.string().max(8).check(utf8MaxBytes(8)) });`)[0]?.pinned).toBe(true);
    expect(detect(`const b = z.object({ x: z.string().check(utf16Max(8)).max(8) });`)[0]?.pinned).toBe(true);
  });

  it('does not borrow a helper from a sibling field', () => {
    const found = detect(`const c = z.object({ a: z.string().max(8), b: z.string().max(8).check(utf8MaxBytes(8)) });`);
    expect(found.map((s) => [s.key, s.pinned])).toEqual([['c.a', false], ['c.b', true]]);
  });

  it('ignores non-string bounds and unmarked limits', () => {
    expect(detect(`const d = z.object({ n: z.number().max(5), list: z.array(z.string()).max(5) });`)).toEqual([]);
    expect(detect(`const e = z.object({\n  // display name\n  name: z.string().max(200),\n});`)[0]?.marked).toBe(false);
    // "go" the verb is not the Go language
    expect(detect(`const f = z.object({\n  // labels go here\n  name: z.string().max(200),\n});`)[0]?.marked).toBe(false);
  });

  it('covers z.coerce.string(), .length(N), chains nested in z.array() and helper-only chains', () => {
    expect(detect(`const g = z.object({ a: z.coerce.string().max(9) });`).map((s) => [s.key, s.bound])).toEqual([['g.a', '9']]);
    expect(detect(`const h = z.object({ a: z.string().length(4) });`)[0]?.bound).toBe('4');
    expect(detect(`const i = z.object({\n  // Go len() bytes\n  a: z.array(z.string().max(30)).max(5),\n});`))
      .toEqual([{ key: 'i.a', bound: '30', line: 3, pinned: false, marked: true }]);
    expect(detect(`const j = z.object({ a: z.string().check(utf16Max(64, 'msg')) })`)[0]).toMatchObject({ bound: '64', pinned: true });
  });
});
