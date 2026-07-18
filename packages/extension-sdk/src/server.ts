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
}

export interface BreezeExtensionV1 {
  register(registrar: ExtensionRegistrar, context: ExtensionRuntimeContext): void | Promise<void>;
}
