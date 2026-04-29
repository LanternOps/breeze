import type { z } from 'zod';

export interface BootstrapTool<TInput = unknown, TOutput = unknown> {
  definition: {
    name: string;
    description: string;
    // Output type is fixed to TInput; input type left open so schemas with
    // `.default()` / `.optional()` on fields still match (their _input type
    // differs from their _output type).
    inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;
  };
  handler: (input: TInput, ctx: BootstrapContext) => Promise<TOutput>;
}

export interface BootstrapContext {
  ip: string | null;
  userAgent: string | null;
  region: 'us' | 'eu';
  apiKey?: {
    id: string;
    partnerId: string;
    defaultOrgId: string;
    partnerAdminEmail: string;
  };
}

export class BootstrapError extends Error {
  constructor(public code: string, message: string, public remediation?: unknown) {
    super(message);
  }
}
