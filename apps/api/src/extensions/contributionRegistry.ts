import type { Hono } from 'hono';
import type {
  ExtensionAiTool,
  ExtensionJobDefinition,
  ExtensionManifestV1,
  ExtensionRegistrar,
} from '@breeze/extension-sdk';

export interface StagedExtensionContributions {
  readonly name: string;
  readonly version: string;
  readonly manifest: ExtensionManifestV1;
  readonly routeApp: Hono | null;
  readonly jobs: ReadonlyMap<string, ExtensionJobDefinition>;
  readonly aiTools: ReadonlyMap<string, ExtensionAiTool>;
  readonly enabled: boolean;
}

export class ExtensionStagingSession {
  private readonly routeApps: Hono[] = [];
  private readonly jobs = new Map<string, ExtensionJobDefinition>();
  private readonly aiTools = new Map<string, ExtensionAiTool>();
  private readonly duplicateJobs = new Set<string>();
  private readonly duplicateAiTools = new Set<string>();

  readonly registrar: ExtensionRegistrar = {
    mountRoute: (app) => {
      this.routeApps.push(app);
    },
    registerJob: (job) => {
      if (this.jobs.has(job.name)) {
        this.duplicateJobs.add(job.name);
        return;
      }
      this.jobs.set(job.name, job);
    },
    registerAiTool: (name, tool) => {
      if (this.aiTools.has(name)) {
        this.duplicateAiTools.add(name);
        return;
      }
      this.aiTools.set(name, tool);
    },
  };

  constructor(private readonly manifest: ExtensionManifestV1) {}

  finish(): StagedExtensionContributions {
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

    this.assertDeclaredNamesMatch();

    return Object.freeze({
      name: this.manifest.name,
      version: this.manifest.version,
      manifest: this.manifest,
      routeApp: this.routeApps[0] ?? null,
      jobs: new Map(this.jobs),
      aiTools: new Map(this.aiTools),
      enabled: true,
    });
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

  begin(manifest: ExtensionManifestV1): ExtensionStagingSession {
    return new ExtensionStagingSession(manifest);
  }

  activate(staged: StagedExtensionContributions): void {
    this.active.set(staged.name, Object.freeze(staged));
  }

  withdraw(name: string): void {
    const current = this.active.get(name);
    if (current) this.active.set(name, Object.freeze({ ...current, enabled: false }));
  }

  get(name: string): StagedExtensionContributions | undefined {
    return this.active.get(name);
  }
}
