// Wisp check-in timers W05 (#10996, web): the check-ins Wisp scheduled on its
// thread. Server contract: `routes/wispCheckIns.ts` under /api/v1/wisp
// (fetchWithAuth adds the prefix). Types come from @breeze/shared — never
// re-typed here.
//
// Both calls are grant-addressed (the thread id), never the org switcher's
// org: `skipOrgIdInjection`, like the links client.
import type { WispCheckIn } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import { i18n } from './i18n';

const checkInsPath = (threadId: string) => `/wisp/thread/${encodeURIComponent(threadId)}/check-ins`;

/** `GET /wisp/thread/:id/check-ins` → the thread's scheduled and fired check-ins, due first. */
export async function listWispCheckIns(threadId: string): Promise<WispCheckIn[]> {
  const res = await fetchWithAuth(checkInsPath(threadId), { skipOrgIdInjection: true });
  if (!res.ok) throw new Error(`wisp check-ins list failed: ${res.status}`);
  const body = (await res.json()) as { data?: { checkIns?: unknown } } | null;
  // A malformed body is a contract break, not "nothing pending": surface it.
  if (!Array.isArray(body?.data?.checkIns)) throw new Error('wisp check-ins list: response has no checkIns array');
  return body.data.checkIns as WispCheckIn[];
}

/**
 * `DELETE /wisp/thread/:id/check-ins/:checkInId` → 204. A check-in that is
 * already consumed or cancelled is a 404, toasted by runAction and thrown as
 * ActionError.
 */
export async function cancelWispCheckIn(threadId: string, checkInId: string): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`${checkInsPath(threadId)}/${encodeURIComponent(checkInId)}`, {
      method: 'DELETE',
      skipOrgIdInjection: true,
    }),
    errorFallback: i18n.t('ai:wisp.checkIn.cancelFailed'),
    successMessage: i18n.t('ai:wisp.checkIn.cancelled'),
  });
}
