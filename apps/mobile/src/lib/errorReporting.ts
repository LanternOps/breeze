import * as Sentry from '@sentry/react-native';

import { DEVICE_BLOCKED_CODE, type ApiError } from '../services/api';

/**
 * Report an internal error to Sentry without rendering its raw message to the
 * user (issues #3115 / #3141): call sites show static copy on screen and route
 * the detail (function name, HTTP status) here instead.
 *
 * `services/api.ts` throws a real `ApiError extends Error` (#4747), so most
 * callers hit the `instanceof Error` branch and are captured as-is. This stays
 * defensive for anything that still throws a plain object or non-Error value
 * (a caught third-party rejection, a stubbed test double, `throw 'string'`) —
 * captured as-is those become stackless synthetic Sentry events that all group
 * into one issue ("Object captured as exception…"), so non-Error values are
 * normalized into a real `Error` keyed on the area and status, with the
 * original value preserved in `extra`.
 */
export function reportInternalError(err: unknown, area: string): void {
  const apiErr = err && typeof err === 'object' ? (err as Partial<ApiError>) : null;

  // Blocked-device responses are an expected administrative state that api.ts
  // already surfaces globally via notifyDeviceBlocked — reporting them as
  // exceptions would spam Sentry on every background poll while blocked.
  if (apiErr?.code === DEVICE_BLOCKED_CODE) return;

  const normalized =
    err instanceof Error
      ? err
      : new Error(
          `${area} failed: ${apiErr?.statusCode ?? '?'} ${apiErr?.message ?? String(err)}`.trim(),
        );

  // A real `ApiError` is `instanceof Error` and takes the branch above
  // unchanged, but Sentry does not auto-serialize a thrown Error subclass's
  // own `code`/`statusCode` properties (no extraErrorDataIntegration
  // configured) — attach them explicitly so the HTTP status/code survives
  // into the event instead of only living in the stack trace.
  const apiExtra =
    apiErr && (apiErr.code !== undefined || apiErr.statusCode !== undefined)
      ? { code: apiErr.code, statusCode: apiErr.statusCode }
      : null;

  Sentry.captureException(normalized, {
    tags: { area },
    ...(err instanceof Error
      ? apiExtra
        ? { extra: apiExtra }
        : {}
      : { extra: { apiError: err } }),
  });
}

/**
 * `reportInternalError` for a catch block that still has state to resolve.
 *
 * `Sentry.captureException` has no no-throw guard of its own, so reporting
 * from a catch block BEFORE the state update that clears a spinner or
 * re-enables a button lets a throwing reporter skip that update entirely —
 * turning a handled failure into a permanently stuck screen, since callers
 * discard the promise. `useSystemsData` learned this the hard way and guards
 * its own reporting call; this is that guard, named, so a call site does not
 * have to re-derive it.
 *
 * Resolve state first and call this, or call this and resolve state after —
 * either order is safe with this wrapper. There is nothing left to report to
 * if the reporter itself is what failed.
 */
export function safeReportInternalError(err: unknown, area: string): void {
  try {
    reportInternalError(err, area);
  } catch {
    // nothing left to report to
  }
}
