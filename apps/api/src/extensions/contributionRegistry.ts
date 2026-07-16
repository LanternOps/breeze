import { Hono } from 'hono';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  ExtensionAiTool,
  ExtensionJobDefinition,
  ExtensionManifestV1,
  ExtensionRegistrar,
} from '@breeze/extension-sdk';

export type ToolInputValidationResult =
  | { success: true }
  | { success: false; error: string };

export interface RegistryAiTool extends ExtensionAiTool {
  readonly validateInput: (input: Record<string, unknown>) => ToolInputValidationResult;
}

class RuntimeImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #data: Map<K, V>;
  readonly [Symbol.toStringTag] = 'Map';

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#data = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#data.size; }
  has(key: K): boolean { return this.#data.has(key); }
  get(key: K): V | undefined { return this.#data.get(key); }
  entries(): MapIterator<[K, V]> { return this.#data.entries(); }
  keys(): MapIterator<K> { return this.#data.keys(); }
  values(): MapIterator<V> { return this.#data.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#data[Symbol.iterator](); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#data) callbackfn.call(thisArg, value, key, this);
  }
}

function cloneAndFreezePlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreezePlain(item))) as T;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone = Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneAndFreezePlain(item)]),
      );
      return Object.freeze(clone) as T;
    }
  }
  return value;
}

function cloneJob(job: ExtensionJobDefinition): ExtensionJobDefinition {
  return Object.freeze({ name: job.name, cron: job.cron, handler: job.handler });
}

function formatSchemaErrors(
  compiler: Ajv,
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) return 'input does not match the declared schema';
  return compiler.errorsText(errors, { separator: '; ' });
}

function cloneAiTool(tool: ExtensionAiTool): RegistryAiTool {
  const schemaCompiler = new Ajv({ allErrors: true, strict: true });
  addFormats(schemaCompiler);
  let validator: ValidateFunction;
  try {
    validator = schemaCompiler.compile(tool.definition.input_schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON Schema for AI tool "${tool.definition.name}": ${message}`);
  }

  return Object.freeze({
    definition: cloneAndFreezePlain(tool.definition),
    tier: tool.tier,
    handler: tool.handler,
    validateInput: (input: Record<string, unknown>): ToolInputValidationResult => (
      validator(input)
        ? { success: true }
        : {
            success: false,
            error: `Invalid input: ${formatSchemaErrors(schemaCompiler, validator.errors)}`,
          }
    ),
    ...(tool.deviceArgs === undefined
      ? {}
      : { deviceArgs: Object.freeze([...tool.deviceArgs]) }),
  });
}

export interface PublishedExtensionRouteApp {
  composeInto(host: Hono, mountPrefix: string): void;
}

function copyAndSealRouteApp(source: Hono | undefined): PublishedExtensionRouteApp | null {
  if (!source) return null;
  const copiedApp = new Hono();
  copiedApp.route('/', source);
  const routes = Object.freeze(copiedApp.routes.map((route) => Object.freeze({
    method: route.method,
    path: route.path,
    handler: route.handler,
  })));
  return Object.freeze({
    composeInto(host: Hono, mountPrefix: string): void {
      const mountedHost = host.basePath(mountPrefix);
      for (const route of routes) mountedHost.on(route.method, route.path, route.handler);
    },
  });
}

export interface StagedExtensionContributions {
  readonly name: string;
  readonly version: string;
  readonly manifest: ExtensionManifestV1;
  readonly routeApp: PublishedExtensionRouteApp | null;
  readonly jobs: ReadonlyMap<string, ExtensionJobDefinition>;
  readonly aiTools: ReadonlyMap<string, RegistryAiTool>;
  readonly enabled: boolean;
}

export interface ExtensionContributionRegistryOptions {
  readonly isReservedAiToolName?: (name: string) => boolean;
}

export class ExtensionStagingSession {
  private readonly routeApps: Hono[] = [];
  private readonly jobs = new Map<string, ExtensionJobDefinition>();
  private readonly aiTools = new Map<string, ExtensionAiTool>();
  private readonly duplicateJobs = new Set<string>();
  private readonly duplicateAiTools = new Set<string>();
  private finished = false;

  readonly registrar: ExtensionRegistrar = Object.freeze({
    mountRoute: (app: Hono) => {
      this.assertOpen();
      this.routeApps.push(app);
    },
    registerJob: (job: ExtensionJobDefinition) => {
      this.assertOpen();
      if (this.jobs.has(job.name)) {
        this.duplicateJobs.add(job.name);
        return;
      }
      this.jobs.set(job.name, job);
    },
    registerAiTool: (name: string, tool: ExtensionAiTool) => {
      this.assertOpen();
      if (this.aiTools.has(name)) {
        this.duplicateAiTools.add(name);
        return;
      }
      this.aiTools.set(name, tool);
    },
  });

  constructor(private readonly manifest: ExtensionManifestV1) {}

  finish(): StagedExtensionContributions {
    this.assertOpen();
    const duplicateJob = this.duplicateJobs.values().next().value;
    if (duplicateJob !== undefined) {
      throw new Error(`Duplicate job registration: ${duplicateJob}`);
    }

    const duplicateAiTool = this.duplicateAiTools.values().next().value;
    if (duplicateAiTool !== undefined) {
      throw new Error(`Duplicate AI tool registration: ${duplicateAiTool}`);
    }

    if (this.routeApps.length > 1) {
      throw new Error('Extension registered more than one route app');
    }

    this.assertAiToolDefinitionNamesMatch();
    this.assertDeclaredNamesMatch();

    const jobs = new RuntimeImmutableMap(
      [...this.jobs].map(([name, job]) => [name, cloneJob(job)] as const),
    );
    const aiTools = new RuntimeImmutableMap(
      [...this.aiTools].map(([name, tool]) => [name, cloneAiTool(tool)] as const),
    );
    const routeApp = copyAndSealRouteApp(this.routeApps[0]);
    const manifest = cloneAndFreezePlain(this.manifest);
    this.finished = true;

    return Object.freeze({
      name: manifest.name,
      version: manifest.version,
      manifest,
      routeApp,
      jobs,
      aiTools,
      enabled: true,
    });
  }

  private assertOpen(): void {
    if (this.finished) throw new Error('Extension staging session is already finished and sealed');
  }

  private assertAiToolDefinitionNamesMatch(): void {
    for (const [registrationName, tool] of this.aiTools) {
      if (tool.definition.name !== registrationName) {
        throw new Error(
          `AI tool registration name "${registrationName}" does not match definition name "${tool.definition.name}"`,
        );
      }
    }
  }

  private assertDeclaredNamesMatch(): void {
    const declaredJobs = new Set(this.manifest.jobs.map((job) => job.name));
    for (const name of declaredJobs) {
      if (!this.jobs.has(name)) throw new Error(`Missing declared job registration: ${name}`);
    }
    for (const name of this.jobs.keys()) {
      if (!declaredJobs.has(name)) throw new Error(`Undeclared job registration: ${name}`);
    }

    const declaredAiTools = new Set(this.manifest.aiTools.map((tool) => tool.name));
    for (const name of declaredAiTools) {
      if (!this.aiTools.has(name)) throw new Error(`Missing declared AI tool registration: ${name}`);
    }
    for (const name of this.aiTools.keys()) {
      if (!declaredAiTools.has(name)) throw new Error(`Undeclared AI tool registration: ${name}`);
    }
  }
}

export class ExtensionContributionRegistry {
  private readonly active = new Map<string, StagedExtensionContributions>();
  private isReservedAiToolName: (name: string) => boolean;

  constructor(options: ExtensionContributionRegistryOptions = {}) {
    this.isReservedAiToolName = options.isReservedAiToolName ?? (() => false);
  }

  configureReservedAiToolNames(predicate: (name: string) => boolean): void {
    if (this.active.size > 0) {
      throw new Error('Cannot configure reserved AI tool names after registry activation');
    }
    const current = this.isReservedAiToolName;
    this.isReservedAiToolName = (name) => current(name) || predicate(name);
  }

  begin(manifest: ExtensionManifestV1): ExtensionStagingSession {
    return new ExtensionStagingSession(manifest);
  }

  activate(staged: StagedExtensionContributions): void {
    for (const toolName of staged.aiTools.keys()) {
      if (this.isReservedAiToolName(toolName)) {
        throw new Error(`AI tool "${toolName}" collides with a reserved core tool name`);
      }
    }
    for (const current of this.active.values()) {
      if (current.name === staged.name || !current.enabled) continue;
      if (current.manifest.routeNamespace === staged.manifest.routeNamespace) {
        throw new Error(
          `Route namespace "${staged.manifest.routeNamespace}" is already owned by extension "${current.name}"`,
        );
      }
      for (const toolName of staged.aiTools.keys()) {
        if (current.aiTools.has(toolName)) {
          throw new Error(
            `AI tool "${toolName}" is already owned by extension "${current.name}"`,
          );
        }
      }
    }
    this.active.set(staged.name, Object.freeze(staged));
  }

  withdraw(name: string): void {
    const current = this.active.get(name);
    if (current) this.active.set(name, Object.freeze({ ...current, enabled: false }));
  }

  get(name: string): StagedExtensionContributions | undefined {
    return this.active.get(name);
  }

  getByRouteNamespace(routeNamespace: string): StagedExtensionContributions | undefined {
    let disabledFallback: StagedExtensionContributions | undefined;
    for (const snapshot of this.active.values()) {
      if (snapshot.manifest.routeNamespace !== routeNamespace) continue;
      if (snapshot.enabled) return snapshot;
      disabledFallback ??= snapshot;
    }
    return disabledFallback;
  }

  getAiTool(name: string): RegistryAiTool | undefined {
    for (const snapshot of this.active.values()) {
      if (!snapshot.enabled) continue;
      const tool = snapshot.aiTools.get(name);
      if (tool) return tool;
    }
    return undefined;
  }

  listAiTools(): readonly RegistryAiTool[] {
    const tools: RegistryAiTool[] = [];
    for (const snapshot of this.active.values()) {
      if (snapshot.enabled) tools.push(...snapshot.aiTools.values());
    }
    return Object.freeze(tools);
  }
}

export const extensionContributionRegistry = new ExtensionContributionRegistry();
