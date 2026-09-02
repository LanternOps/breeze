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

function attachmentNames(file: string): string[] {
  const sourceText = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
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
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
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
