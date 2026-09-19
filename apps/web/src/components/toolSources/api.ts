// Typed fetch wrappers for the Tool Sources API (tool catalog W01, #5216),
// mounted at `/tool-sources`.
//
// Same idiom as lib/api/ticketChecklistTemplates.ts: no generic apiClient,
// every route responds with a `{ data: ... }` envelope, and `unwrapData` /
// `Fetcher` come from lib/api/serviceDeliverables.ts rather than being
// re-implemented. Callers wrap these in `runClientAction` so every mutation
// surfaces its outcome (CLAUDE.md, "Web Mutation Handlers").
//
// A source is org-owned OR partner-wide (`orgId === null`). `ownerScope` is
// CREATE-ONLY — the API's update schema omits it, because re-homing a source
// across the ownership axis would expose one org's credential to every org
// under the partner (or strand a partner-wide source's tools).

import type { ToolSourceDto, ToolSourceToolDto, ToolTier } from '@breeze/shared';
import { unwrapData, type Fetcher } from '../../lib/api/serviceDeliverables';
import { extractApiError } from '../../lib/apiError';
import { ActionError } from '../../lib/runAction';

export type { Fetcher };
export type { ToolSourceDto, ToolSourceToolDto, ToolTier };

/** The create body, mirroring `createToolSourceSchema` (@breeze/shared). */
export type CreateToolSourceBody = {
  ownerScope: 'organization' | 'partner';
  orgId?: string;
  name: string;
  slug: string;
  kind: 'mcp';
  endpointUrl: string;
  rateLimitPerMinute: number;
} & (
  | { authKind: 'none' }
  | { authKind: 'bearer'; authConfig: { token: string } }
  | { authKind: 'api_key_header'; authConfig: { headerName: string; value: string } }
  | { authKind: 'basic'; authConfig: { username: string; password: string } }
  | {
      authKind: 'oauth2_client_credentials';
      authConfig: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string };
    }
);

/** The update body: create-only fields (slug/kind/ownerScope/orgId) are absent
 *  by construction, and auth may be replaced wholesale or left untouched. */
export type UpdateToolSourceBody = Partial<
  Pick<CreateToolSourceBody, 'name' | 'endpointUrl' | 'rateLimitPerMinute'>
> &
  Partial<Extract<CreateToolSourceBody, { authKind: string }>>;

export interface ToolTestResult {
  result: string;
  isError: boolean;
  durationMs: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BASE = '/tool-sources';

const sourcePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const toolPath = (id: string, toolId: string) =>
  `${sourcePath(id)}/tools/${encodeURIComponent(toolId)}`;

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function listToolSources(f: Fetcher): Promise<ToolSourceDto[]> {
  return unwrapData<ToolSourceDto[]>(await f(BASE));
}

export async function getToolSource(f: Fetcher, id: string): Promise<ToolSourceDto> {
  return unwrapData<ToolSourceDto>(await f(sourcePath(id)));
}

export type DiscoveryWarning = { warning?: 'discovery_not_queued' };
export type SavedToolSource = ToolSourceDto & DiscoveryWarning;

async function unwrapDiscoveryResult<T>(response: Response): Promise<T & DiscoveryWarning> {
  const envelope = await response.clone().json().catch(() => null);
  const data = await unwrapData<T>(response);
  return envelope?.warning === 'discovery_not_queued'
    ? { ...data, warning: 'discovery_not_queued' }
    : data as T & DiscoveryWarning;
}

export async function createToolSource(
  f: Fetcher,
  body: CreateToolSourceBody,
): Promise<SavedToolSource> {
  return unwrapDiscoveryResult<ToolSourceDto>(await f(BASE, jsonInit('POST', body)));
}

export async function updateToolSource(
  f: Fetcher,
  id: string,
  body: UpdateToolSourceBody,
): Promise<SavedToolSource> {
  return unwrapDiscoveryResult<ToolSourceDto>(await f(sourcePath(id), jsonInit('PATCH', body)));
}

/**
 * DELETE /tool-sources/:id answers `{ success: true, id }` — the repo's normal
 * delete-route shape (CLAUDE.md "Web Mutation Handlers") — never a `{ data }`
 * envelope. `unwrapData` requires that envelope, so running the DELETE through
 * it turned every successful delete into a toasted "missing data envelope"
 * error and stranded the user on the page (found by the 2026-09-16 pre-release
 * sweep). Any 2xx is success here; a non-2xx is reported the same way
 * `unwrapData` reports one, so callers still get a real error message/code.
 */
export async function deleteToolSource(f: Fetcher, id: string): Promise<void> {
  const res = await f(sourcePath(id), { method: 'DELETE' });
  if (res.ok) return;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const code =
    body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : undefined;
  throw new ActionError(extractApiError(body, `Request failed (${res.status})`), res.status, code, body);
}

export async function discoverToolSource(f: Fetcher, id: string): Promise<DiscoveryWarning> {
  return unwrapDiscoveryResult<DiscoveryWarning>(await f(`${sourcePath(id)}/discover`, { method: 'POST' }));
}

export async function listSourceTools(f: Fetcher, id: string): Promise<ToolSourceToolDto[]> {
  return unwrapData<ToolSourceToolDto[]>(await f(`${sourcePath(id)}/tools`));
}

export async function patchSourceTool(
  f: Fetcher,
  id: string,
  toolId: string,
  body: { tier?: ToolTier; enabled?: boolean },
): Promise<ToolSourceToolDto> {
  return unwrapData<ToolSourceToolDto>(await f(toolPath(id, toolId), jsonInit('PATCH', body)));
}

export async function bulkTools(
  f: Fetcher,
  id: string,
  mode: 'enable_reads' | 'disable_all',
): Promise<{ mode: string; updated: number }> {
  return unwrapData<{ mode: string; updated: number }>(
    await f(`${sourcePath(id)}/tools/bulk`, jsonInit('POST', { mode })),
  );
}

/**
 * Test-call a Tier-1 tool.
 *
 * The route deliberately answers HTTP 200 for a FAILED remote call, carrying
 * `success: false` and the failure text in `data.result` (api/routes/toolSources.ts).
 * `unwrapData` only inspects the status, so it would resolve that as a success
 * and the caller would toast a green "test succeeded" over a failed call —
 * the exact shape `runAction`'s `{success:false}` rule exists to catch. The
 * check is therefore made here, in the one client that talks to this route,
 * and raised as an `ActionError` carrying the failure text so `runClientAction`
 * toasts it.
 */
/**
 * The backend wraps an `isError` executor result as `JSON.stringify({ error:
 * text })` (apps/api/src/routes/toolSources.ts) so the success:false rule
 * never reads a failed remote call as green. That's a wire-format detail the
 * UI must undo, not a message to show verbatim — otherwise the test drawer
 * renders the raw JSON blob instead of the human-readable reason (sweep
 * paper cut #9). A `success:false` envelope with `isError:false` (a refusal
 * at the route itself, not the executor's own verdict) ships plain text and
 * is returned unchanged.
 */
function unwrapTransportError(result: string, isError: boolean): string {
  if (!isError) return result;
  try {
    const parsed: unknown = JSON.parse(result);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not the wrapped JSON shape — fall through to the raw text.
  }
  return result;
}

export async function testSourceTool(
  f: Fetcher,
  id: string,
  toolId: string,
  input: Record<string, unknown>,
): Promise<ToolTestResult> {
  const res = await f(`${toolPath(id, toolId)}/test`, jsonInit('POST', { input }));
  // Deliberately NOT `unwrapData`: it decides on the status alone, and this
  // route answers 200 for a failed remote call. The body is read once, here,
  // and both failure shapes (a real HTTP error, and a 200 carrying
  // `success:false`) are raised as ActionError so the caller's
  // runClientAction toasts the real reason.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ActionError(`Malformed response body (${res.status})`, res.status);
  }
  const envelope = (body ?? {}) as { success?: unknown; data?: unknown; error?: unknown; code?: unknown };
  const result = envelope.data as ToolTestResult | undefined;
  if (!res.ok) {
    throw new ActionError(
      typeof envelope.error === 'string' ? envelope.error : `Request failed (${res.status})`,
      res.status,
      typeof envelope.code === 'string' ? envelope.code : undefined,
      body,
    );
  }
  if (!result || typeof result.result !== 'string') {
    throw new ActionError(`Unexpected response shape (${res.status}): missing data envelope`, res.status, undefined, body);
  }
  if (envelope.success === false || result.isError) {
    throw new ActionError(
      unwrapTransportError(result.result, result.isError),
      res.status,
      'tool_test_failed',
      body,
    );
  }
  return result;
}
