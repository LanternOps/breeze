// Shared "open a past conversation" hydration (#9427). The side panel's
// loadSession and the workspace tab both need the same GET /ai/sessions/:id
// interpretation; keeping it here means a tab can be hydrated without touching
// the singleton aiStore. GET only - this never mutates.
//
// Loads on the topology island: use a narrow validator import, not the shared runtime barrel.
import { aiPageContextSchema } from '@breeze/shared/validators/ai';
import type { AiPageContext, AiTurnModel } from '@breeze/shared';
import { fetchWithAuth } from './auth';
import { mapMessagesFromApi, type AiMessage } from './processStreamEvent';

export interface AiSessionView {
  id: string;
  title: string | null;
  status: 'active' | 'closed' | 'expired';
  orgId: string;
  type: 'general' | 'topology';
  deviceId: string | null;
  isFlagged: boolean;
  flagReason: string | null;
  lastTurnModel: AiTurnModel | null;
  m365ConnectionId: string | null;
  pageContext: AiPageContext | null;
  topologySiteId: string | null;
  /** The Wisp grant the session runs under (#10142); null for a plain chat. Immutable for the session. */
  wispGrantId: string | null;
  /** The session object as served, for aiStore's topologyFieldsOf. */
  raw: Record<string, unknown>;
}

export type OpenAiSessionResult =
  | { kind: 'ok'; view: AiSessionView; messages: AiMessage[] }
  | { kind: 'not_found' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

/** Only chat sessions are reachable by open/attach; every other type is "not found". */
export function isChatSessionType(t: unknown): t is 'general' | 'topology' {
  return t === 'general' || t === 'topology';
}

/**
 * The stored context snapshot minus the server's `orgAnchor` marker (added by
 * aiSessionOrgAnchor.ts; it is not part of AiPageContext and must not be sent
 * back on the next message).
 */
export function pageContextFromSnapshot(snapshot: unknown): AiPageContext | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const { orgAnchor: _orgAnchor, ...rest } = snapshot as Record<string, unknown>;
  const parsed = aiPageContextSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export async function openAiSession(sessionId: string): Promise<OpenAiSessionResult> {
  try {
    const res = await fetchWithAuth(`/ai/sessions/${sessionId}`);
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error', message: 'Failed to load session' };
    const data = await res.json();
    const session = data?.session as Record<string, unknown> | undefined;
    if (!session || !isChatSessionType(session.type)) return { kind: 'not_found' };
    if (session.status !== 'active') return { kind: 'closed' };
    const view: AiSessionView = {
      id: String(session.id ?? sessionId),
      title: str(session.title),
      status: 'active',
      orgId: String(session.orgId ?? ''),
      type: session.type,
      deviceId: str(session.deviceId),
      isFlagged: !!session.flaggedAt,
      flagReason: str(session.flagReason),
      lastTurnModel: (session.lastTurnModel ?? data.lastTurnModel ?? null) as AiTurnModel | null,
      m365ConnectionId: str(session.delegantM365ConnectionId),
      pageContext: pageContextFromSnapshot(session.contextSnapshot),
      topologySiteId: str(session.topologySiteId),
      wispGrantId: str(session.wispGrantId),
      raw: session,
    };
    return { kind: 'ok', view, messages: mapMessagesFromApi(data.messages || []) };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'Failed to load session' };
  }
}
