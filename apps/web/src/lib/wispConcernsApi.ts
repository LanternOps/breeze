// Wisp W05a (web): triage-engine concerns for the caller's grant. Server
// contract: apps/api routes under /api/v1/wisp/concerns (fetchWithAuth adds
// the /api/v1 prefix). Types come from @breeze/shared — never re-typed here.
import type { Concern, ConcernRecipientState, ConcernStatus } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import { i18n } from './i18n';

/**
 * `crossOrg`: list the whole grant. Without it the org switcher's ambient
 * `?orgId=` narrows the list (the chat sidebar's behaviour); the thread page
 * passes it because its subject is the grant, and a nudge's concern may sit in
 * an org other than the one the switcher shows.
 */
export async function listWispConcerns(
  grantId: string,
  status?: ConcernStatus[],
  opts?: { crossOrg?: boolean },
): Promise<Concern[]> {
  const query = `grantId=${encodeURIComponent(grantId)}${status && status.length ? `&status=${status.join(',')}` : ''}`;
  const url = `/wisp/concerns?${query}`;
  const res = opts?.crossOrg ? await fetchWithAuth(url, { skipOrgIdInjection: true }) : await fetchWithAuth(url);
  if (!res.ok) throw new Error(`wisp concerns list failed: ${res.status}`);
  const body = (await res.json()) as { concerns?: unknown } | null;
  // A malformed body is a contract break, not "no concerns": surface it.
  if (!Array.isArray(body?.concerns)) throw new Error('wisp concerns list: response has no concerns array');
  return body.concerns as Concern[];
}

async function postConcernAction(
  id: string,
  verb: 'snooze' | 'dismiss' | 'resolve',
  payload: Record<string, unknown>,
  successMessage: string,
): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/wisp/concerns/${encodeURIComponent(id)}/${verb}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    errorFallback: i18n.t('ai:wispConcerns.actionFailed'),
    successMessage,
  });
}

export function snoozeWispConcern(id: string, grantId: string, until: Date): Promise<void> {
  return postConcernAction(id, 'snooze', { grantId, until: until.toISOString() }, i18n.t('ai:wispConcerns.snoozed'));
}

export function dismissWispConcern(id: string, grantId: string): Promise<void> {
  return postConcernAction(id, 'dismiss', { grantId }, i18n.t('ai:wispConcerns.dismissed'));
}

/**
 * W06 Task 16 (w00 A34): `POST /wisp/concerns/:id/feedback { grantId, useful, note? }`
 * → `{ data: { recipient } }`. Returns the server's recipient state (null for
 * a body without it). The server answers 409 for a different second answer.
 */
export async function feedbackWispConcern(
  id: string,
  grantId: string,
  useful: boolean,
  note?: string,
): Promise<ConcernRecipientState | null> {
  const trimmed = note?.trim();
  const body = await runAction<{ data?: { recipient?: ConcernRecipientState } } | null>({
    request: () => fetchWithAuth(`/wisp/concerns/${encodeURIComponent(id)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantId, useful, ...(trimmed ? { note: trimmed } : {}) }),
    }),
    errorFallback: i18n.t('ai:wispConcerns.actionFailed'),
    successMessage: i18n.t('ai:wispConcerns.feedbackSaved'),
  });
  return body?.data?.recipient ?? null;
}

export function resolveWispConcern(id: string, grantId: string, outcome: string): Promise<void> {
  return postConcernAction(id, 'resolve', { grantId, outcome }, i18n.t('ai:wispConcerns.resolved'));
}
