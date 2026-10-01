/**
 * AI model registry invariants (#7598 index "Invariants" #1, #2; spec §8, §9):
 *  1. no hard-coded Claude model id outside the bootstrap fallback;
 *  2. `new Anthropic(` only in the connection factory;
 *  3. `buildWireParams(` only inside services/aiModels/, and W01's per-model-id
 *     wire helpers only where no offering exists;
 *  4. the SDK's `total_cost_usd` read only by the telemetry extractor
 *     (invocationUsage.ts → `sdkReportedCostUsd` → ai_invocations.sdk_reported_cost_usd).
 * AST-based (comments never trip it), mirroring neutralCore.guard.test.ts.
 * Correctness is proven by the per-surface parity suites; this keeps the
 * hard-coded lists from growing back (quorum #14).
 *
 * Every exemption names its reason, and "every exemption is still needed"
 * fails once the exempted code is gone, so the lists cannot silently rot.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const ROOTS = ['apps/api/src', 'ee', 'packages/shared/src', 'packages/extension-sdk/src', 'apps/web/src'];
/** Test-only trees (fixtures, harnesses) and generated output. */
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.tsbuild', '__tests__', '__fixtures__', '__testutils__', 'migrations', '.astro']);
const MODEL_ID = /^claude-[a-z]+-\d/;

type Rule = 1 | 2 | 3 | 4;

/** path (repo-relative, '/'-separated) → why it may contain a model literal. ≥ 20 chars each. */
const MODEL_LITERAL_ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/aiModel.ts': 'Bootstrap fallback for a fresh self-host before the first platform sync (index invariant #1).',
  'apps/api/src/db/schema/ai.ts': 'Stale ai_budgets.allowed_models column default; W08 (#7606) drops it with the column. (The ai_sessions.model default is dropped in Task 9.)',
  'apps/api/src/services/aiModels/legacySurfaceModels.ts': 'W02 legacy projection inputs (frozen legacy defaults + LEGACY_MODEL_RATES) for the per-partner cutover; W08 deletes them.',
};
/** Directory prefixes whose files may carry model literals. */
const MODEL_LITERAL_ALLOWLIST_PREFIXES: Record<string, string> = {
  'apps/api/src/services/aiModels/parity/': 'W02/W03 parity fixtures are test-support data describing legacy configs; W08 deletes the harness.',
};
/** Files that may construct an Anthropic client. */
const ANTHROPIC_CTOR_ALLOWED: Record<string, string> = {
  'apps/api/src/services/aiModels/connectionFactory.ts': 'The connection factory: the one place credential pinning is applied.',
  'apps/api/src/services/aiModels/__scripts__/modelsApiProbe.ts':
    'Hand-run W01 spike (tsx) probing the public Models API with the operator key; never imported by the server.',
  'apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts':
    'Hand-run W05 spike (tsx) counting tokens against the public API; never imported by the server.',
};
/** Files outside services/aiModels/ that may call buildWireParams(. */
const WIRE_PARAMS_ALLOWED: Record<string, string> = {
  'apps/api/src/services/llm/providerFidelityHarness.ts':
    'Platform-admin vetting harness probing a catalog endpoint before any offering exists; nothing to resolve.',
};
/** Files that may read the SDK's total_cost_usd. */
const SDK_COST_ALLOWED: Record<string, string> = {
  'apps/api/src/services/aiModels/invocationUsage.ts': 'The telemetry extractor: copies it to sdkReportedCostUsd, which the ledger stores and never bills.',
  'apps/api/src/services/llm/toolCapture/streamObserver.ts':
    'Dev tool-capture observer: prints the SDK figure in a local eval report; never reaches billing or the ledger.',
  'apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts':
    'Hand-run W05 spike recording the SDK figure as evidence of its cumulative behaviour; never imported by the server.',
};
const MODEL_ID_WIRE_HELPERS = new Set(['agentSdkWireOptions', 'messagesApiWireOptions']);
const MODEL_ID_WIRE_HELPER_ALLOWED_PREFIXES = [
  'apps/api/src/services/aiModels/',
  'apps/api/src/services/llm/providerFidelityHarness.ts',
  'apps/api/src/services/llm/toolCapture/',
];
const literalAllowed = (file: string) =>
  Boolean(MODEL_LITERAL_ALLOWLIST[file]) || Object.keys(MODEL_LITERAL_ALLOWLIST_PREFIXES).some((p) => file.startsWith(p));
const SDK_COST_KEY = 'total_cost_usd';

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|integration\.test)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export interface Violation { file: string; rule: Rule; line: number; text: string }

/** `ignoreExemptions` reports what the file WOULD violate, so stale exemptions can be detected. */
export function scanSource(file: string, source: string, opts: { ignoreExemptions?: boolean } = {}): Violation[] {
  const strict = opts.ignoreExemptions === true;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const v: Violation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && MODEL_ID.test(n.text) && (strict || !literalAllowed(file))) {
      v.push({ file, rule: 1, line: at(n), text: n.text });
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Anthropic' && (strict || !ANTHROPIC_CTOR_ALLOWED[file])) {
      v.push({ file, rule: 2, line: at(n), text: 'new Anthropic(' });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'buildWireParams'
      && !file.startsWith('apps/api/src/services/aiModels/') && (strict || !WIRE_PARAMS_ALLOWED[file])) {
      v.push({ file, rule: 3, line: at(n), text: 'buildWireParams(' });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && MODEL_ID_WIRE_HELPERS.has(n.expression.text)
      && !MODEL_ID_WIRE_HELPER_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) {
      v.push({ file, rule: 3, line: at(n), text: `${n.expression.text}(` });
    }
    // `.total_cost_usd`, `?.total_cost_usd`, `['total_cost_usd']` and `{ total_cost_usd }` destructuring.
    const readsSdkCost =
      (ts.isPropertyAccessExpression(n) && n.name.text === SDK_COST_KEY)
      || (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === SDK_COST_KEY)
      || (ts.isBindingElement(n) && ((n.propertyName && ts.isIdentifier(n.propertyName) && n.propertyName.text === SDK_COST_KEY)
        || (!n.propertyName && ts.isIdentifier(n.name) && n.name.text === SDK_COST_KEY)));
    if (readsSdkCost && (strict || !SDK_COST_ALLOWED[file])) {
      v.push({ file, rule: 4, line: at(n), text: SDK_COST_KEY });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return v;
}

const relPath = (full: string) => relative(REPO, full).split(sep).join('/');

describe('AI model registry contract', () => {
  it('the scanner fires on each rule (control)', () => {
    const src = [
      "const a = 'claude-opus-5-5';",
      'const b = new Anthropic({ apiKey });',
      'const c = buildWireParams(x);',
      'const c2 = agentSdkWireOptions(model);',
      'const d = result.total_cost_usd;',
      "const d2 = result?.['total_cost_usd'];",
      'const { total_cost_usd } = result;',
      'const { total_cost_usd: cost } = result;',
      "// 'claude-sonnet-4-6' in a comment is fine",
      "const e = 'claude-desktop';",
      'const f = { total_cost_usd: 1 };', // writing a fixture shape is not a read
    ].join('\n');
    expect(scanSource('apps/api/src/services/someSurface.ts', src).map((x) => x.rule)).toEqual([1, 2, 3, 3, 4, 4, 4, 4]);
  });

  it('an exempt file passes only for its own rule', () => {
    const src = "const c = new Anthropic({ apiKey }); const m = 'claude-opus-5-5';";
    expect(scanSource('apps/api/src/services/aiModels/connectionFactory.ts', src).map((x) => x.rule)).toEqual([1]);
  });

  it('every allowlist entry exists and carries a real reason', () => {
    const all = { ...MODEL_LITERAL_ALLOWLIST, ...ANTHROPIC_CTOR_ALLOWED, ...WIRE_PARAMS_ALLOWED, ...SDK_COST_ALLOWED };
    for (const [file, reason] of Object.entries({ ...all, ...MODEL_LITERAL_ALLOWLIST_PREFIXES })) {
      expect(reason.length, file).toBeGreaterThanOrEqual(20);
      expect(() => statSync(join(REPO, file)), file).not.toThrow();
    }
  });

  it('every exemption is still needed (remove it once its code is gone)', () => {
    const needs = (file: string, rule: Rule) =>
      scanSource(file, readFileSync(join(REPO, file), 'utf8'), { ignoreExemptions: true }).some((x) => x.rule === rule);
    const stale: string[] = [];
    for (const file of Object.keys(MODEL_LITERAL_ALLOWLIST)) if (!needs(file, 1)) stale.push(`rule 1: ${file}`);
    for (const prefix of Object.keys(MODEL_LITERAL_ALLOWLIST_PREFIXES)) {
      const files = walk(join(REPO, prefix), []).map(relPath);
      if (!files.some((f) => needs(f, 1))) stale.push(`rule 1: ${prefix}`);
    }
    for (const file of Object.keys(ANTHROPIC_CTOR_ALLOWED)) if (!needs(file, 2)) stale.push(`rule 2: ${file}`);
    for (const file of Object.keys(WIRE_PARAMS_ALLOWED)) if (!needs(file, 3)) stale.push(`rule 3: ${file}`);
    for (const file of Object.keys(SDK_COST_ALLOWED)) if (!needs(file, 4)) stale.push(`rule 4: ${file}`);
    expect(stale).toEqual([]);
  });

  it('no violations in the repo', () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
    expect(files.length).toBeGreaterThan(500);   // proves the walk actually ran
    const violations = files.flatMap((full) => scanSource(relPath(full), readFileSync(full, 'utf8')));
    expect(violations).toEqual([]);
  }, 60_000);
});
