import type { z } from 'zod';

export interface BootstrapTool<TInput = unknown, TOutput = unknown> {
  definition: {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<TInput>;
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
    scopeState: 'readonly' | 'full';
  };
}

// Unauth bootstrap tools — callable pre-activation without an API key.
// Authed bootstrap tools (e.g. `send_deployment_invites`) are NOT listed here;
// they flow through the normal authed tools/call path just like any AI tool.
export const BOOTSTRAP_TOOL_NAMES = ['create_tenant', 'verify_tenant', 'attach_payment_method'] as const;
export type BootstrapToolName = (typeof BOOTSTRAP_TOOL_NAMES)[number];

export class BootstrapError extends Error {
  constructor(public code: string, message: string, public remediation?: unknown) {
    super(message);
  }
}
