import { ticketImportLimits } from './importLimits';
import type { SourceCredentials, SourceHandle } from './moduleContract';
import { createSourceClient, type SourceClient } from './sourceFetch';

/**
 * The handle a module is called with (spec 2026-10-19 §5.2): the source,
 * decrypted, and a client bound to its stored base URL with the deployment's
 * timeout and per-source concurrency. Built per route call or per slice and
 * never stored.
 */
export function buildSourceHandle<Options>(input: {
  sourceId: string;
  baseUrl: string;
  credentials: SourceCredentials;
  options: Options;
  /** Tests inject a client. */
  http?: SourceClient;
}): SourceHandle<Options> {
  const limits = ticketImportLimits();
  const http = input.http ?? createSourceClient(input.baseUrl, {
    timeoutMs: limits.sourceTimeoutMs,
    concurrency: limits.sourceConcurrency,
  });
  return {
    sourceId: input.sourceId,
    baseUrl: http.baseUrl,
    credentials: input.credentials,
    options: input.options,
    http,
  };
}
