import type { Hono } from 'hono';

export interface ExtensionJobDefinition {
  name: string;
  cron: string;
  handler: () => Promise<void>;
}

export interface ExtensionAiTool {
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  tier: 1 | 2 | 3 | 4;
  handler: (input: Record<string, unknown>, auth: unknown) => Promise<string>;
  deviceArgs?: readonly string[];
}

export interface ExtensionRegistrar {
  mountRoute(app: Hono): void;
  registerJob(job: ExtensionJobDefinition): void;
  registerAiTool(name: string, tool: ExtensionAiTool): void;
}

export interface ExtensionRuntimeContext {
  db: Record<string, unknown> & { execute(query: unknown): Promise<unknown> };
  secrets: {
    encryptForColumn(table: string, column: string, plaintext: string): string;
    decryptForColumn(table: string, column: string, ciphertext: string): string;
  };
  audit(event: Record<string, unknown>): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
  config: Readonly<Record<string, unknown>>;
  tenancy: {
    /**
     * The org ids this extension is currently activated for (enabled installs
     * only) — the set a background sweep should iterate instead of enumerating
     * tenants itself. Fresh host-side read per call, in the HOST's system
     * scope; the extension never self-elevates.
     *
     * Throws for `installScope: "server"` extensions (there is no per-org
     * install set) and on any read failure — an unreadable set must never be
     * mistaken for an empty one. `[]` always means "activated for no orgs".
     */
    installedOrgs(): Promise<string[]>;
  };
}

export interface BreezeExtensionV1 {
  register(registrar: ExtensionRegistrar, context: ExtensionRuntimeContext): void | Promise<void>;
}
