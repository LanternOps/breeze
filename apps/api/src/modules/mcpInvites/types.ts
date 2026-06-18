import type { z } from 'zod';

export interface BootstrapTool<TInput = unknown, TOutput = unknown> {
  definition: {
    name: string;
    description: string;
    // Output type is fixed to TInput; input left open (v4 dropped the 3-generic
    // ZodType<Output, Def, Input> form and removed ZodTypeDef) so schemas with
    // `.default()` / `.optional()` on fields still match (their input type
    // differs from their output type).
    inputSchema: z.ZodType<TInput, any>;
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
