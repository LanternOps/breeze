/**
 * Tool Catalog W05 (#5220), plan Task B4 — the `http_request` built-in.
 * Filled in by Task B4; until then it refuses without sending anything.
 */
import type { StepOutcome } from '../stepExecutor';
import type { BuiltinContext } from './types';

export interface HttpRequestInput {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function executeHttpRequestStep(_input: HttpRequestInput, _ctx: BuiltinContext & { literalOrigin: string }): Promise<StepOutcome> {
  return { kind: 'failed', code: 'tool_unavailable', message: 'http_request is not available yet.', policy: true };
}
