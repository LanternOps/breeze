import type { AgentConfig } from './helperFetch';

/**
 * Build a URL for the Workspace extension's `/helper/*` surface. Extracted
 * verbatim from workspaceStore so the chat tool executors hit the identical
 * base path (device mTLS, org scoping, visibility all apply by construction).
 */
export function workspaceUrl(
  config: AgentConfig,
  path: string,
  params?: URLSearchParams,
): string {
  const qs = params && params.size > 0 ? `?${params.toString()}` : '';
  return `${config.api_url}/api/v1/workspace/helper${path}${qs}`;
}
