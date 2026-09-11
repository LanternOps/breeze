import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { WORKER_READINESS_MANIFEST } from './workerReadinessManifest';

const API_SRC = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['jobs', 'services', 'workers'].map((dir) => path.join(API_SRC, dir));

interface CoverageFailure {
  file: string;
  constructors: number;
  attachments: number;
}

function listProductionTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      listProductionTsFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function analyzeSource(file: string, sourceText: string): CoverageFailure {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  let constructors = 0;
  let attachments = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node)
      && (node.expression.getText(source) === 'Worker'
        || node.expression.getText(source) === 'WebhookDeliveryWorker')
    ) {
      constructors += 1;
    }
    if (
      ts.isCallExpression(node)
      && (node.expression.getText(source) === 'attachWorkerObservability'
        || node.expression.getText(source) === 'workerReadinessRegistry.attach')
    ) {
      attachments += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { file, constructors, attachments };
}

function productionCoverage(): CoverageFailure[] {
  return SCAN_ROOTS
    .flatMap((root) => listProductionTsFiles(root))
    .map((file) => analyzeSource(file, readFileSync(file, 'utf8')))
    .filter(({ constructors, attachments }) => constructors > 0 && constructors !== attachments)
    .map(({ file, constructors, attachments }) => ({
      file: path.relative(API_SRC, file).split(path.sep).join('/'),
      constructors,
      attachments,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * `const NAME = 'literal'` bindings in this module, so an attach site that
 * names its queue through a constant is still visible to the scan.
 * Deliberately narrow: only a `const` whose initializer is a string literal.
 * A binding that is not one (a parameter, a computed name) stays unresolved
 * and is skipped, which is why `attachWorkerObservability`'s own forwarding
 * call to `workerReadinessRegistry.attach(name)` inside workerObservability.ts
 * does not register as a site.
 */
function stringConstants(source: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isStringLiteral(node.initializer)
      && ts.isVariableDeclarationList(node.parent)
      // eslint-disable-next-line no-bitwise
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      out.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function attachmentNamesFromSource(file: string, sourceText: string): string[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const constants = stringConstants(source);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const nameArg = callee === 'attachWorkerObservability'
        ? node.arguments[1]
        : callee === 'workerReadinessRegistry.attach'
          ? node.arguments[0]
          : undefined;
      if (nameArg && ts.isStringLiteral(nameArg)) names.push(nameArg.text);
      else if (nameArg && ts.isIdentifier(nameArg)) {
        const resolved = constants.get(nameArg.text);
        if (resolved !== undefined) names.push(resolved);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function attachmentNames(file: string): string[] {
  return attachmentNamesFromSource(file, readFileSync(file, 'utf8'));
}

// The two scans below parse every production module under jobs/, services/
// and workers/ with the TypeScript compiler (~3 s idle); on a loaded runner
// they overrun vitest's 5 s default, so they get an explicit 30 s budget.
const AST_SCAN_TIMEOUT_MS = 30_000;

describe('production BullMQ consumer readiness coverage', () => {
  it('attaches observability exactly once for every Worker construction site', () => {
    expect(
      productionCoverage(),
      'Each entry is a complete missing/duplicate attachment site list',
    ).toEqual([]);
  }, AST_SCAN_TIMEOUT_MS);

  it('matches every attached stable name to the manifest exactly once', () => {
    const attached = SCAN_ROOTS
      .flatMap((root) => listProductionTsFiles(root))
      .flatMap(attachmentNames)
      .sort();
    const declared = WORKER_READINESS_MANIFEST.flatMap((entry) =>
      entry.kind === 'consumers' ? [...entry.consumers] : [],
    ).sort();
    expect(attached).toEqual(declared);
  }, AST_SCAN_TIMEOUT_MS);

  it('resolves an attach name given as a module-local string const', () => {
    // jobs/aiBudgetAlertDelivery.ts attaches with AI_BUDGET_ALERT_QUEUE, not a
    // literal. Before this resolution the site was invisible to the scan, so a
    // consumer could be declared-but-never-attached (permanently `expected`,
    // /ready 503 forever) without this contract noticing.
    const source = `
      import { Worker } from 'bullmq';
      export const QUEUE = 'ai-budget-alert-delivery';
      const worker = new Worker(QUEUE, async () => undefined);
      attachWorkerObservability(worker, QUEUE);
    `;
    expect(attachmentNamesFromSource('const-named.ts', source)).toEqual(['ai-budget-alert-delivery']);
  });

  it('skips an attach name it cannot resolve to a string const', () => {
    // The forwarding call inside attachWorkerObservability itself names a
    // parameter; it is not an attach site and must not become one.
    const source = `
      export function attachWorkerObservability(worker: unknown, name: string) {
        workerReadinessRegistry.attach(name, worker);
      }
    `;
    expect(attachmentNamesFromSource('forwarder.ts', source)).toEqual([]);
  });

  it('fails closed when an initializer silently succeeds without attaching its Worker', () => {
    const source = `
      import { Worker } from 'bullmq';
      export function initializeSilentWorker() {
        const worker = new Worker('silent', async () => undefined);
        return worker;
      }
    `;
    expect(analyzeSource('silent.ts', source)).toEqual({
      file: 'silent.ts',
      constructors: 1,
      attachments: 0,
    });
  });

  it('fails closed on duplicate attachment', () => {
    const source = `
      import { Worker } from 'bullmq';
      const worker = new Worker('duplicate', async () => undefined);
      attachWorkerObservability(worker, 'duplicateWorker');
      attachWorkerObservability(worker, 'duplicateWorker');
    `;
    expect(analyzeSource('duplicate.ts', source)).toEqual({
      file: 'duplicate.ts',
      constructors: 1,
      attachments: 2,
    });
  });
});
