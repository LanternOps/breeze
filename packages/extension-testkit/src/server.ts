import type { Hono } from 'hono';
import type {
  BreezeExtensionV1,
  ExtensionAiTool,
  ExtensionJobDefinition,
  ExtensionRegistrar,
  ExtensionRuntimeContext,
} from '@breeze/extension-sdk';
import type { ConformanceResult, Issue } from './manifest';

/** Minimal database seam a test can supply to exercise real query code. */
export interface StageDbAdapter {
  execute(query: unknown): Promise<unknown>;
}

export interface StageExtensionOptions {
  /**
   * Optional database adapter. When omitted, the staged context's `db` THROWS on
   * any access — a permissive stub would let a broken extension pass unnoticed.
   */
  db?: StageDbAdapter;
}

/** What the recording registrar captured during a successful `register`. */
export interface RecordedContributions {
  routes: number;
  jobs: string[];
  aiTools: string[];
}

export interface StageExtensionResult extends ConformanceResult {
  recorded: RecordedContributions;
}

class RecordingRegistrar implements ExtensionRegistrar {
  routes = 0;
  readonly jobs: string[] = [];
  readonly aiTools: string[] = [];

  mountRoute(_app: Hono): void {
    this.routes += 1;
  }

  registerJob(job: ExtensionJobDefinition): void {
    this.jobs.push(job.name);
  }

  registerAiTool(name: string, _tool: ExtensionAiTool): void {
    this.aiTools.push(name);
  }
}

function throwingDb(): ExtensionRuntimeContext['db'] {
  const fail = (): never => {
    throw new Error(
      'extension accessed the database, but stageExtensionForTest was called without a db adapter. '
      + 'Pass `opts.db` to exercise database code under test. A permissive stub is intentionally refused.',
    );
  };
  return new Proxy({} as ExtensionRuntimeContext['db'], {
    get: () => fail,
  });
}

function createContext(options: StageExtensionOptions): ExtensionRuntimeContext {
  const db: ExtensionRuntimeContext['db'] = options.db
    ? ({ execute: (query: unknown) => options.db!.execute(query) } as ExtensionRuntimeContext['db'])
    : throwingDb();
  return {
    db,
    secrets: {
      encryptForColumn: (_table, _column, plaintext) => plaintext,
      decryptForColumn: (_table, _column, ciphertext) => ciphertext,
    },
    audit: async () => {},
    log: () => {},
    config: Object.freeze({}),
  };
}

function declaredNames(manifest: unknown, key: 'jobs' | 'aiTools'): Set<string> {
  const list = (manifest as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(list)) return new Set();
  const names = list
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string');
  return new Set(names);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register an extension against a recording registrar and a deliberately hostile
 * runtime context, then cross-check what it registered against its manifest.
 *
 * Safety properties:
 * - the `db` throws unless the test supplies an adapter (see {@link throwingDb});
 * - a thrown `register` yields a single `register_threw` issue and leaves the
 *   recorder empty (no partial contributions are surfaced);
 * - any job/AI-tool registered but not declared in the manifest is an
 *   `undeclared_contribution`; declared-but-unregistered is the softer
 *   `declared_not_registered`.
 */
export async function stageExtensionForTest(
  extension: BreezeExtensionV1,
  manifest: unknown,
  opts: StageExtensionOptions = {},
): Promise<StageExtensionResult> {
  const registrar = new RecordingRegistrar();
  const context = createContext(opts);

  try {
    await extension.register(registrar, context);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', code: 'register_threw', message: errorMessage(error) }],
      recorded: { routes: 0, jobs: [], aiTools: [] },
    };
  }

  const declaredJobs = declaredNames(manifest, 'jobs');
  const declaredAiTools = declaredNames(manifest, 'aiTools');
  const issues: Issue[] = [];

  // Undeclared contributions first — the load-bearing "manifest lies by omission" check.
  for (const name of registrar.jobs) {
    if (!declaredJobs.has(name)) {
      issues.push({ path: `jobs.${name}`, code: 'undeclared_contribution', message: `job "${name}" is registered but not declared in the manifest` });
    }
  }
  for (const name of registrar.aiTools) {
    if (!declaredAiTools.has(name)) {
      issues.push({ path: `aiTools.${name}`, code: 'undeclared_contribution', message: `AI tool "${name}" is registered but not declared in the manifest` });
    }
  }
  // Declared-but-unregistered second — a softer signal that the manifest overpromises.
  for (const name of declaredJobs) {
    if (!registrar.jobs.includes(name)) {
      issues.push({ path: `jobs.${name}`, code: 'declared_not_registered', message: `job "${name}" is declared in the manifest but was never registered` });
    }
  }
  for (const name of declaredAiTools) {
    if (!registrar.aiTools.includes(name)) {
      issues.push({ path: `aiTools.${name}`, code: 'declared_not_registered', message: `AI tool "${name}" is declared in the manifest but was never registered` });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    recorded: { routes: registrar.routes, jobs: registrar.jobs, aiTools: registrar.aiTools },
  };
}
