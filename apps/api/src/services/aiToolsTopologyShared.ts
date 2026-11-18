/**
 * Shared helpers for the W08 network-topology tools (full-control W08, #6778).
 *
 * Every tool is a thin adapter over the exported services the topology REST
 * routes call. This module owns the three things each adapter needs:
 *  - `topologySite`: the route's `requireTopologySiteCapability` as a function
 *    (live permissions, org + site ceilings, capability floor);
 *  - `topologyFailure`: the route's error mapping (`topologyOperation`,
 *    `topologyMutation`, `read`) as a tool result, never a raw driver message;
 *  - `boundedJson`: a hard ceiling on what one result may hand the model.
 *
 * Import-light on purpose: the db graph is reached only through the services.
 */
import { ZodError } from 'zod';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, type UserPermissions } from './permissions';
import { sanitizeThrownToolError } from './aiToolErrors';
import { requireTopologySiteAccess, TopologyError, type TopologyCapability, type TopologyRequestContext } from './topology/access';
import { GraphReadError } from './topology/graphCursor';
import { TopologyOperationError } from './topology/operationErrors';
import { TopologyWriteError } from './topology/writes';
import { agentRefusal, isAgentPrincipal, json, jsonError } from './aiToolsTicketOpsShared';

export { agentRefusal, isAgentPrincipal, json, jsonError };

/** The most one topology result may hand the model (the chat path compacts further). */
export const TOPOLOGY_TOOL_MAX_BYTES = 96 * 1024;

export async function topologyPermissions(auth: AuthContext): Promise<UserPermissions | null> {
  return getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  });
}

/**
 * `requireTopologySiteCapability(capability)` as a function. The site's stored
 * org binds everything downstream; an unknown, hidden, out-of-ceiling or
 * out-of-site site is one indistinguishable `topology_site_not_found`.
 */
export async function topologySite(
  auth: AuthContext,
  siteId: unknown,
  capability: TopologyCapability,
): Promise<{ ctx: TopologyRequestContext } | { error: string }> {
  if (typeof siteId !== 'string' || !siteId) return { error: jsonError('siteId (site UUID) is required', 'VALIDATION_ERROR') };
  const permissions = await topologyPermissions(auth);
  if (!permissions) return { error: jsonError('Topology permission denied', 'topology_permission_denied') };
  try {
    return { ctx: await requireTopologySiteAccess(auth, permissions, siteId, capability) };
  } catch (error) {
    const mapped = topologyFailure(error, 'topology-site');
    if (mapped) return { error: mapped };
    throw error;
  }
}

/** The one refusal for an unknown, hidden, out-of-ceiling or out-of-site site. */
export const hiddenSiteResult = (): string => JSON.stringify({ error: 'Topology site not found', code: 'topology_site_not_found' });

/** The route error mapping, as a tool result. `null` = not a known topology error (caller decides). */
export function topologyFailure(error: unknown, label: string): string | null {
  if (error instanceof TopologyOperationError) {
    return JSON.stringify({
      error: error.message,
      code: error.code,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
  }
  if (error instanceof TopologyWriteError) {
    return JSON.stringify({ error: error.message, code: error.code, ...(error.details ?? {}) });
  }
  if (error instanceof TopologyError || error instanceof GraphReadError) {
    return JSON.stringify({ error: error.message, code: error.code });
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return jsonError(`${where}${issue?.message ?? 'Invalid topology request'}`, 'invalid_request');
  }
  if (pgErrorCode(error) === '23505') {
    return jsonError('Topology configuration changed, or a record with this key already exists; re-read the current revision and keys before retrying', 'revision_conflict');
  }
  void label;
  return null;
}

/** Map a thrown error to a result: known topology errors verbatim, anything else generic + logged. */
export function topologyThrown(label: string, error: unknown): string {
  const mapped = topologyFailure(error, label);
  if (mapped) return mapped;
  // sanitizeThrownToolError logs the full error once; never log the raw driver error object (it can carry tenant parameters).
  console.error(`[${label}]`, sanitizeThrownToolError(label, error));
  return jsonError('Operation failed. Check server logs for details.');
}

/** Serialise a result, refusing one that would flood the model's context. */
export function boundedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length > TOPOLOGY_TOOL_MAX_BYTES) {
    return jsonError('Result too large; narrow the request (smaller limit, a focusNodeId, or a cursor page).', 'result_too_large');
  }
  return text;
}

/**
 * Serialise the result of a WRITE that has already committed. An oversized body must never read as a failure
 * (the model would retry a single-use or terminal action), so it degrades to a committed summary instead.
 */
export function committedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= TOPOLOGY_TOOL_MAX_BYTES) return text;
  const record = (value ?? {}) as Record<string, unknown>;
  const keep = ['id', 'state', 'revision', 'graphRevision', 'settingsRevision', 'key', 'lifecycle', 'runId', 'success'] as const;
  return JSON.stringify({
    committed: true,
    truncated: true,
    ...Object.fromEntries(keep.filter((k) => k in record).map((k) => [k, record[k]])),
    note: 'The change was applied; the full result was too large to return. Read it back with the matching read action.',
  });
}

/** First missing required field, as a validation error result (or null). */
export function requireFields(input: Record<string, unknown>, fields: readonly string[], action: string): string | null {
  const missing = fields.filter((field) => input[field] === undefined || input[field] === null || input[field] === '');
  return missing.length
    ? jsonError(`${missing.join(', ')} required for ${action}`, 'VALIDATION_ERROR')
    : null;
}

/** Drop undefined keys so a service's strict schema sees only what the caller supplied. */
export function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
