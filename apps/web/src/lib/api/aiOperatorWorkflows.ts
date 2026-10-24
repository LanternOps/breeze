/**
 * Recipe Library client (Operator Recipe Library W06 R1b, feature #6165).
 *
 * Mirrors the as-built R1a routes in `apps/api/src/routes/aiOperatorTasks.ts`:
 *  - `GET  /ai/operator/workflows?orgId=` — the Library, readiness computed from
 *    rows on every call (never cached as authority; the server rechecks it on
 *    every admission and before every dispatch).
 *  - `POST /ai/operator/task-drafts` — writes nothing; returns the person
 *    resolution and the effect TOOLS the plan would use (never a plan).
 *  - `POST /ai/operator/tasks` — admission.
 *  - `GET` + `PATCH /ai/agents/:id` — the "allow these tools" setup action.
 *
 * The mutating functions return the raw `Response` on purpose: every call site
 * wraps them in `runAction` (the `no-silent-mutations` guard resolves these
 * wrappers and fails any bare call), and the parsers below are its
 * `parseSuccess`. Reads stay plain so their surfaces can render an inline
 * error with a retry instead of a toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiOperatorIdentityTaskDraftDto,
  AiOperatorWorkflowDto,
  OperatorTaskDraftInput,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** `updateAiAgentSchema.toolAllowlist`'s `.max(300)`. */
export const AGENT_TOOL_ALLOWLIST_MAX = 300;

export class WorkflowsLoadError extends Error {
  /**
   * @param status HTTP status (0 = no response).
   * @param serverMessage The server's own `error` text for a 4xx refusal, shown
   *   to the reader instead of a generic "failed to load".
   */
  constructor(readonly status: number, readonly serverMessage: string | null = null) {
    super(`Recipe Library failed to load (${status})`);
    this.name = 'WorkflowsLoadError';
  }

  /** A refusal (4xx) will not change on retry; a 5xx or a broken body might. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status < 400;
  }
}

/** The `error` text of a JSON error body, or null. */
export async function readServerError(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body && typeof body.error === 'string' && body.error.trim() ? body.error : null;
}

/**
 * The Library for ONE org. The org is pinned (`orgIdOverride`), not left to the
 * ambient switcher: a launcher on a ticket or a contact names that record's
 * org, which need not be the one currently selected.
 */
export async function fetchOperatorWorkflows(orgId: string): Promise<AiOperatorWorkflowDto[]> {
  const res = await fetchWithAuth(`/ai/operator/workflows?orgId=${encodeURIComponent(orgId)}`, { orgIdOverride: orgId });
  if (!res.ok) {
    throw new WorkflowsLoadError(res.status, res.status >= 400 && res.status < 500 ? await readServerError(res) : null);
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  // A wrong-shaped body is a broken response, not "no recipes".
  if (!body || !Array.isArray(body.data)) throw new WorkflowsLoadError(res.status);
  return body.data as AiOperatorWorkflowDto[];
}

export function createOperatorTaskDraft(body: OperatorTaskDraftInput): Promise<Response> {
  return fetchWithAuth('/ai/operator/task-drafts', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    orgIdOverride: body.orgId,
  });
}

export function parseOperatorTaskDraft(data: unknown): AiOperatorIdentityTaskDraftDto {
  const draft = (data as { data?: unknown } | null)?.data as Partial<AiOperatorIdentityTaskDraftDto> | undefined;
  if (
    !draft
    || typeof draft.recipeKey !== 'string'
    || !draft.workflow
    || !draft.person
    || !Array.isArray(draft.person.candidates)
    || !Array.isArray(draft.plannedEffectTools)
    || !Array.isArray(draft.degradedEffectTools)
    || !Array.isArray(draft.manualWork)
  ) {
    throw new Error('Malformed task draft');
  }
  return draft as AiOperatorIdentityTaskDraftDto;
}

export interface StartOperatorTaskArgs {
  /** The Library row the technician reviewed: its key AND version go on the wire. */
  workflow: Pick<AiOperatorWorkflowDto, 'recipeKey' | 'recipeVersion'>;
  orgId: string;
  inputs: Record<string, unknown>;
  /** One per form session; reused verbatim on a retry of the same submission. */
  clientIdempotencyKey: string;
}

/**
 * Admit a task. `mode` is always `'live'` and the version is the one the
 * Library returned, never a literal: the server refuses a version it has moved
 * past (422) rather than silently upgrading what the technician reviewed.
 *
 * There is deliberately no source citation: `identity_offboarding` refuses
 * `sourceKind`/`sourceId` (400) and opens its own checklist ticket instead.
 */
export function startOperatorTask(args: StartOperatorTaskArgs): Promise<Response> {
  return fetchWithAuth('/ai/operator/tasks', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      mode: 'live',
      recipeKey: args.workflow.recipeKey,
      recipeVersion: args.workflow.recipeVersion,
      orgId: args.orgId,
      inputs: args.inputs,
      clientIdempotencyKey: args.clientIdempotencyKey,
    }),
    orgIdOverride: args.orgId,
  });
}

export function parseStartedOperatorTask(data: unknown): { taskId: string; replayed: boolean } {
  const body = data as { taskId?: unknown; replayed?: unknown } | null;
  if (!body || typeof body.taskId !== 'string') throw new Error('Malformed admission response');
  return { taskId: body.taskId, replayed: body.replayed === true };
}

/** `createOperatorTaskSchema.clientIdempotencyKey` is 8–200 chars. */
export function newClientIdempotencyKey(): string {
  return `offboard-${crypto.randomUUID()}`;
}

function syntheticJson(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

/**
 * Add tools to an agent's allowlist — ADD ONLY.
 *
 * Reads the agent, appends each requested tool that is not already present
 * (existing entries keep their order, including action-scoped ones such as
 * `manage_services:restart`), and PATCHes `{ toolAllowlist }` and nothing else.
 * It can never remove, reorder or truncate an entry a partner set:
 *  - nothing missing → no PATCH at all (a synthetic 200);
 *  - the union would pass the schema cap → refused here (a synthetic 422,
 *    code `AGENT_TOOL_ALLOWLIST_FULL`), never truncated;
 *  - a failed read → that response is returned unchanged, so `runAction`
 *    surfaces it (a 401 to the auth redirect, a 403 to its toast).
 *
 * The PATCH route requires MFA; its `MFA_REQUIRED` 403 reaches the caller's
 * `runAction` like any other refusal.
 */
export async function addToolsToAgent(agentId: string, toolNames: readonly string[]): Promise<Response> {
  const path = `/ai/agents/${encodeURIComponent(agentId)}`;
  const read = await fetchWithAuth(path);
  if (!read.ok) return read;
  const body = (await read.json().catch(() => null)) as { data?: { toolAllowlist?: unknown } } | null;
  const existing = body?.data?.toolAllowlist;
  if (!Array.isArray(existing) || existing.some((t) => typeof t !== 'string')) {
    return syntheticJson({ error: 'The agent could not be read.', code: 'AGENT_READ_MALFORMED' }, 502);
  }
  const have = new Set(existing as string[]);
  const missing: string[] = [];
  for (const tool of toolNames) {
    if (!have.has(tool)) {
      have.add(tool);
      missing.push(tool);
    }
  }
  if (missing.length === 0) return syntheticJson({ data: { added: [] } }, 200);
  const next = [...(existing as string[]), ...missing];
  if (next.length > AGENT_TOOL_ALLOWLIST_MAX) {
    return syntheticJson({
      error: `This agent already allows ${existing.length} tools; adding ${missing.length} would pass the limit of ${AGENT_TOOL_ALLOWLIST_MAX}.`,
      code: 'AGENT_TOOL_ALLOWLIST_FULL',
      limit: AGENT_TOOL_ALLOWLIST_MAX,
      existing: existing.length,
      adding: missing.length,
    }, 422);
  }
  return fetchWithAuth(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ toolAllowlist: next }) });
}

/** Display-only read of the agent a setup action changes, so its button can name it. */
export async function fetchAgentSummary(agentId: string): Promise<{ id: string; name: string; allOrgs: boolean }> {
  const res = await fetchWithAuth(`/ai/agents/${encodeURIComponent(agentId)}`);
  if (!res.ok) throw new Error(`agent read failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown; name?: unknown; allOrgs?: unknown } } | null;
  const data = body?.data;
  if (!data || typeof data.name !== 'string') throw new Error('agent read malformed');
  return { id: agentId, name: data.name, allOrgs: data.allOrgs === true };
}

// ---------------------------------------------------------------------------
// The readiness hook
// ---------------------------------------------------------------------------

export type WorkflowsState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `message` is the server's own refusal text for a 4xx; `retryable` is false for those. */
  | { status: 'error'; message: string | null; retryable: boolean }
  /** A refresh keeps the rows on screen; `refreshFailed` says the latest refresh did not land. */
  | { status: 'ready'; workflows: AiOperatorWorkflowDto[]; refreshFailed?: boolean };

/**
 * Concurrent readers of one org's Library share a single request (a contacts
 * table renders one launcher per row). Only the in-flight promise is shared:
 * a later mount refetches, because readiness is recomputed from rows on every
 * call and a stale "ready" must not hide a launcher-killing change.
 */
const inFlight = new Map<string, Promise<AiOperatorWorkflowDto[]>>();

function loadShared(orgId: string): Promise<AiOperatorWorkflowDto[]> {
  const existing = inFlight.get(orgId);
  if (existing) return existing;
  const p = fetchOperatorWorkflows(orgId).finally(() => inFlight.delete(orgId));
  inFlight.set(orgId, p);
  return p;
}

/** The org's Library, or `idle` while `enabled` is false (no request is made). */
export function useOperatorWorkflows(orgId: string | null, enabled = true): WorkflowsState & { reload: () => void } {
  const [state, setState] = useState<WorkflowsState>({ status: 'idle' });
  const seq = useRef(0);
  /** The org the `ready` rows on screen belong to. */
  const readyFor = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!orgId || !enabled) {
      readyFor.current = null;
      setState({ status: 'idle' });
      return;
    }
    const mine = ++seq.current;
    // A REFRESH of the same org keeps the current rows mounted: replacing them
    // with a loading state would unmount whatever the caller rendered from them
    // (an open start form, its inputs and its preview). A different org never
    // inherits the previous org's rows.
    const refresh = readyFor.current === orgId;
    if (!refresh) readyFor.current = null;
    setState((prev) => (refresh && prev.status === 'ready' ? { ...prev, refreshFailed: false } : { status: 'loading' }));
    loadShared(orgId).then(
      (workflows) => {
        if (mine !== seq.current) return;
        readyFor.current = orgId;
        setState({ status: 'ready', workflows });
      },
      (err: unknown) => {
        if (mine !== seq.current) return;
        console.warn('[aiOperatorWorkflows] library load failed', err);
        const message = err instanceof WorkflowsLoadError ? err.serverMessage : null;
        const retryable = err instanceof WorkflowsLoadError ? err.retryable : true;
        setState((prev) => (refresh && prev.status === 'ready'
          ? { ...prev, refreshFailed: true }
          : { status: 'error', message, retryable }));
      },
    );
  }, [orgId, enabled]);

  useEffect(() => {
    load();
    return () => { seq.current += 1; };
  }, [load]);

  return { ...state, reload: load };
}
