/**
 * AI model registry invariants (#7598 index "Invariants" #1, #2; spec §8, §9):
 *  1. no hard-coded Claude model id outside the bootstrap fallback;
 *  2. `new Anthropic(` only in the connection factory;
 *  3. `buildWireParams(` only inside services/aiModels/, and W01's per-model-id
 *     wire helpers only where no offering exists;
 *  4. the SDK's `total_cost_usd` read only by the telemetry extractor
 *     (invocationUsage.ts → `sdkReportedCostUsd` → ai_invocations.sdk_reported_cost_usd);
 *  5. (W06) one chat runtime: the env-only OpenAI-compatible transport
 *     (`isOpenAICompatibleProvider`, `OpenAISessionManager`) never comes back
 *     in apps/api/src — env deployments resolve through the registry;
 *  6. (W06) the partner-endpoint hop (`forwardUpstream`, gateway/forward.ts) is
 *     reachable only from services/aiModels/gateway/: no file outside it
 *     imports gateway/forward or calls forwardUpstream, so no other code can
 *     dial a partner base URL through it;
 *  7. (W06) a gateway client carries only GATEWAY_PLACEHOLDER_KEY: every
 *     createAnthropicClient call with a literal `{ kind: 'gateway' }` target
 *     passes it as `apiKey`, and the gateway-bound `new Anthropic(` (baseURL
 *     GATEWAY_CLIENT_BASE_URL — the sentinel URL the grant fetch rewrites)
 *     sets `apiKey: GATEWAY_PLACEHOLDER_KEY` with the ambient bearer nulled,
 *     whatever `spec.apiKey` a caller passes.
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

type Rule = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** path (repo-relative, '/'-separated) → why it may contain a model literal. ≥ 20 chars each. */
const MODEL_LITERAL_ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/aiModel.ts': 'Bootstrap fallback for a fresh self-host before the first platform sync (index invariant #1).',
};
/** Directory prefixes whose files may carry model literals. */
const MODEL_LITERAL_ALLOWLIST_PREFIXES: Record<string, string> = {
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
/** Rule 5: identifiers of the deleted env-only chat runtime (apps/api/src only). */
const LEGACY_CHAT_RUNTIME_IDENTIFIERS = new Set(['isOpenAICompatibleProvider', 'OpenAISessionManager']);
const API_SRC = 'apps/api/src/';
/** Rule 6. */
const GATEWAY_DIR = 'apps/api/src/services/aiModels/gateway/';
const GATEWAY_FORWARD_MODULE = 'apps/api/src/services/aiModels/gateway/forward';
/** Rule 7. */
const GATEWAY_PLACEHOLDER = 'GATEWAY_PLACEHOLDER_KEY';
const GATEWAY_BASE_URL_CONST = 'GATEWAY_CLIENT_BASE_URL';

/** The repo-relative module a relative specifier resolves to (extension and trailing /index stripped). */
function resolveSpecifier(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = file.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/').replace(/\.(ts|tsx|js|mjs)$/, '').replace(/\/index$/, '');
}

function objectProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}
const isIdent = (e: ts.Expression | undefined, name: string) => Boolean(e && ts.isIdentifier(e) && e.text === name);
const isNullLiteral = (e: ts.Expression | undefined) => Boolean(e && e.kind === ts.SyntaxKind.NullKeyword);

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
    if (ts.isIdentifier(n) && LEGACY_CHAT_RUNTIME_IDENTIFIERS.has(n.text) && file.startsWith(API_SRC)) {
      v.push({ file, rule: 5, line: at(n), text: n.text });
    }
    // Rule 6: static imports / re-exports and dynamic `import('…')`.
    const specifier =
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)
        ? n.moduleSpecifier.text
        : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])
          ? n.arguments[0].text
          : null;
    if (specifier !== null && !file.startsWith(GATEWAY_DIR) && resolveSpecifier(file, specifier) === GATEWAY_FORWARD_MODULE) {
      v.push({ file, rule: 6, line: at(n), text: `import '${specifier}'` });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'forwardUpstream' && !file.startsWith(GATEWAY_DIR)) {
      v.push({ file, rule: 6, line: at(n), text: 'forwardUpstream(' });
    }
    // Rule 7a: a literal gateway target is always paired with the placeholder key.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createAnthropicClient'
      && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
      const target = objectProp(n.arguments[0], 'target');
      const kind = target && ts.isObjectLiteralExpression(target) ? objectProp(target, 'kind') : undefined;
      if (kind && ts.isStringLiteralLike(kind) && kind.text === 'gateway' && !isIdent(objectProp(n.arguments[0], 'apiKey'), GATEWAY_PLACEHOLDER)) {
        v.push({ file, rule: 7, line: at(n), text: "createAnthropicClient({ target: { kind: 'gateway' } }) without GATEWAY_PLACEHOLDER_KEY" });
      }
    }
    // Rule 7b: the client bound to the gateway's sentinel URL holds only the placeholder, bearer nulled.
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Anthropic'
      && n.arguments?.[0] && ts.isObjectLiteralExpression(n.arguments[0])
      && isIdent(objectProp(n.arguments[0], 'baseURL'), GATEWAY_BASE_URL_CONST)) {
      const opts = n.arguments[0];
      if (!isIdent(objectProp(opts, 'apiKey'), GATEWAY_PLACEHOLDER) || !isNullLiteral(objectProp(opts, 'authToken'))) {
        v.push({ file, rule: 7, line: at(n), text: 'gateway-bound new Anthropic( without GATEWAY_PLACEHOLDER_KEY / authToken: null' });
      }
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

  it('rule 5: the env-only chat runtime identifiers fire in apps/api/src only (control)', () => {
    const src = 'if (isOpenAICompatibleProvider()) new OpenAISessionManager(p);\n// isOpenAICompatibleProvider in a comment is fine';
    expect(scanSource('apps/api/src/routes/ai.ts', src).map((x) => x.rule)).toEqual([5, 5]);
    // A path outside apps/api/src (built, not a literal: CI's cross-area path
    // scanner would read a literal as a real reference to a web file).
    const webPath = ['apps', 'web', 'src', 'lib', 'x.ts'].join('/');
    expect(scanSource(webPath, src)).toEqual([]);
  });

  it('rule 6: gateway/forward is reachable only inside services/aiModels/gateway/ (control)', () => {
    const outside = [
      "import { forwardUpstream } from './gateway/forward';",
      "export { forwardUpstream } from './gateway/forward.ts';",
      "const m = await import('./gateway/forward');",
      'await forwardUpstream(grant, req);',
    ].join('\n');
    expect(scanSource('apps/api/src/services/aiModels/discovery.ts', outside).map((x) => x.rule)).toEqual([6, 6, 6, 6]);
    expect(scanSource('apps/api/src/routes/x.ts', "import { f } from '../services/aiModels/gateway/forward';").map((x) => x.rule)).toEqual([6]);
    expect(scanSource('apps/api/src/services/aiModels/gateway/openai/adapter.ts', "import { forwardUpstream } from '../forward';\nforwardUpstream(g, r);")).toEqual([]);
    expect(scanSource('apps/api/src/services/aiModels/discovery.ts', "import { scrubSecrets } from './gateway/scrub';")).toEqual([]);
  });

  it('rule 7: a gateway client is built only with GATEWAY_PLACEHOLDER_KEY (control)', () => {
    const bad = [
      "createAnthropicClient({ apiKey: conn.credential, target: { kind: 'gateway', dialect: 'anthropic', openGrant } });",
      "createAnthropicClient({ apiKey: 'breeze-gateway', target: { kind: 'gateway', dialect: 'anthropic', openGrant } });",
      'new Anthropic({ baseURL: GATEWAY_CLIENT_BASE_URL, apiKey: spec.apiKey, authToken: null });',
      'new Anthropic({ baseURL: GATEWAY_CLIENT_BASE_URL, apiKey: GATEWAY_PLACEHOLDER_KEY });',
    ].join('\n');
    expect(scanSource('apps/api/src/services/aiModels/connectionFactory.ts', bad).map((x) => x.rule)).toEqual([7, 7, 7, 7]);
    const good = [
      "createAnthropicClient({ apiKey: GATEWAY_PLACEHOLDER_KEY, target: { kind: 'gateway', dialect: 'anthropic', openGrant } });",
      "createAnthropicClient({ apiKey: key, target: { kind: 'anthropic' } });",
      'new Anthropic({ baseURL: GATEWAY_CLIENT_BASE_URL, apiKey: GATEWAY_PLACEHOLDER_KEY, authToken: null, fetch: f });',
    ].join('\n');
    expect(scanSource('apps/api/src/services/aiModels/connectionFactory.ts', good)).toEqual([]);
  });

  it('rule 7 is not vacuous: the factory still builds its gateway client the checked way', () => {
    const factory = readFileSync(join(REPO, 'apps/api/src/services/aiModels/connectionFactory.ts'), 'utf8');
    expect(factory).toMatch(/new Anthropic\(\{\s*baseURL: GATEWAY_CLIENT_BASE_URL,/);
    expect(factory).toMatch(/createAnthropicClient\(\{\s*apiKey: GATEWAY_PLACEHOLDER_KEY,\s*target: \{\s*kind: 'gateway'/);
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
