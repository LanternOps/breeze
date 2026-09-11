import { ActionError, runAction, type RunActionOptions } from './runAction';

/**
 * Bridge between the typed deliverables client and `runAction`.
 *
 * `runAction` owns the toast contract but takes a raw `() => Promise<Response>`,
 * while every `lib/api/*` client function (deliverables, key dates) already consumes the Response
 * (unwrapping `{ data }` and throwing `ActionError` with the parsed body). This
 * re-materialises the client's outcome as a Response so `runAction` still sees
 * the real status + `{ error, code }` body — the friendly/401/trust-denial
 * branches keep working and the thrown `ActionError.code` survives (the drawer
 * relies on `EVIDENCE_REQUIRED`, the form on `DUPLICATE_NAME`). Network
 * failures (status 0) are rethrown so `runAction` toasts `errorFallback`.
 */
export function runClientAction<T>(
  run: () => Promise<T>,
  opts: Pick<RunActionOptions<T>, 'errorFallback' | 'successMessage' | 'onUnauthorized'>,
): Promise<T> {
  return runAction<T>({
    ...opts,
    request: async () => {
      try {
        const data = await run();
        return new Response(JSON.stringify({ data: data ?? null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        if (err instanceof ActionError && err.status > 0) {
          const body = err.body && typeof err.body === 'object' ? err.body : { error: err.message, code: err.code };
          return new Response(JSON.stringify(body), {
            status: err.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw err;
      }
    },
    parseSuccess: (raw) => (raw as { data: T }).data,
  });
}
