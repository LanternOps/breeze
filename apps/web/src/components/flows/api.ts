// Typed GET-only fetch wrappers for the Flows API (tool catalog W3, #5218),
// mounted at `/flows`. The surface is read-only in this release, so nothing
// here mutates and nothing goes through `runAction`.
//
// Unlike the tool-sources routes, these answer bare bodies (`{ flows, total }`,
// `{ flow, validation }`) rather than a `{ data }` envelope.

import type { FlowDetailDto, FlowSummaryDto, FlowStatus, FlowValidationResult } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { ActionError } from '../../lib/runAction';

export type { FlowDetailDto, FlowSummaryDto, FlowStatus, FlowValidationResult };

const BASE = '/flows';

export interface ListFlowsParams {
  orgId?: string;
  status?: FlowStatus;
  limit?: number;
  offset?: number;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new ActionError(extractApiError(body, `Request failed (${res.status})`), res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ActionError(`Malformed response body (${res.status})`, res.status);
  }
}

export async function listFlows(
  params: ListFlowsParams = {},
): Promise<{ flows: FlowSummaryDto[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.orgId) qs.set('orgId', params.orgId);
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();
  const body = await readJson<{ flows?: FlowSummaryDto[]; total?: number }>(
    await fetchWithAuth(query ? `${BASE}?${query}` : BASE),
  );
  if (!Array.isArray(body?.flows)) {
    throw new ActionError('Unexpected response shape: missing flows', 200);
  }
  return { flows: body.flows, total: typeof body.total === 'number' ? body.total : body.flows.length };
}

export async function getFlow(
  id: string,
): Promise<{ flow: FlowDetailDto; validation: FlowValidationResult }> {
  const body = await readJson<{ flow?: FlowDetailDto; validation?: FlowValidationResult }>(
    await fetchWithAuth(`${BASE}/${encodeURIComponent(id)}`),
  );
  if (!body?.flow || !body.validation) {
    throw new ActionError('Unexpected response shape: missing flow', 200);
  }
  return { flow: body.flow, validation: body.validation };
}
