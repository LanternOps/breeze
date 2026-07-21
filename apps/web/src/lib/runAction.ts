import { showToast } from '../components/shared/Toast';
import { extractApiError, isApiFailure } from './apiError';

export class ActionError extends Error {
  code?: string;
  status: number;
  /** Parsed response body, when the failure carried one. Routes that return
   *  structured detail with their error (e.g. a 409 listing what blocks a
   *  delete) would otherwise have it thrown away, leaving the UI unable to
   *  tell the user WHY. Undefined for network failures and 401s. */
  body?: unknown;
  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface RunActionOptions<T> {
  request: () => Promise<Response>;
  errorFallback: string;
  successMessage?: string | ((data: T) => string);
  parseSuccess?: (data: unknown) => T;
  /** Maps a machine error token to user-facing copy. Called with `body.code`
   *  when present, otherwise with `body.error` — routes that only emit a bare
   *  `{ error: 'some_token' }` (e.g. the approvals decide route's
   *  `step_up_required`) would otherwise toast the raw token verbatim. */
  friendly?: (code: string) => string | undefined;
  onUnauthorized?: () => void;
  /**
   * Opt in to treating a 401 as a normal, toastable failure instead of "your
   * session expired". Required by routes that proxy a *downstream* 401 —
   * `/mobile/approvals/:id/(approve|deny)` answers 401 for `assertion_failed`
   * and `reauth_required`, which are WebAuthn-proof rejections, not session
   * expiry. Without this the failure is swallowed silently (see the 401 branch
   * below). Default false, so every pre-existing caller is unchanged.
   */
  treatUnauthorizedAsError?: boolean;
}

export async function runAction<T = unknown>(opts: RunActionOptions<T>): Promise<T> {
  let response: Response;
  try {
    response = await opts.request();
  } catch {
    showToast({ message: opts.errorFallback, type: 'error' });
    throw new ActionError(opts.errorFallback, 0);
  }

  // 401: session expired. Intentionally no error toast — onUnauthorized (a
  // redirect to /login in the targeted callers) IS the feedback; a toast on
  // top of a navigation is noise. Spec: 2026-05-15-ws-a-action-feedback-design.md
  // Caveat: this assumes 401 always means "your session expired". An endpoint
  // that proxies a *downstream* 401 (e.g. an approve rejected because the
  // WebAuthn assertion failed) would be silently swallowed here — such callers
  // must pass `treatUnauthorizedAsError` so the body-based branch below toasts
  // the real reason.
  if (response.status === 401 && !opts.treatUnauthorizedAsError) {
    if (opts.onUnauthorized) opts.onUnauthorized();
    throw new ActionError('Unauthorized', 401);
  }

  const data: unknown = await response.json().catch(() => null);

  if (isApiFailure(data, response.status)) {
    let message = extractApiError(data, opts.errorFallback);
    const code = (data && typeof data === 'object'
      ? (data as Record<string, unknown>).code
      : undefined) as string | undefined;
    // Fall back to `error` for the friendly lookup only — ActionError.code keeps
    // its original meaning so existing consumers are unaffected. Routes that
    // return a machine token in `error` with no `code` (approvals decide:
    // `step_up_required`) would otherwise toast that token verbatim.
    const errorToken = (data && typeof data === 'object'
      ? (data as Record<string, unknown>).error
      : undefined);
    const friendlyKey = code ?? (typeof errorToken === 'string' ? errorToken : undefined);
    if (friendlyKey && opts.friendly) {
      const friendly = opts.friendly(friendlyKey);
      if (friendly) message = friendly;
    }
    showToast({ message, type: 'error' });
    throw new ActionError(message, response.status, code, data);
  }

  let result: T;
  try {
    result = (opts.parseSuccess ? opts.parseSuccess(data) : (data as T));
  } catch {
    showToast({ message: opts.errorFallback, type: 'error' });
    throw new ActionError(opts.errorFallback, response.status);
  }
  if (opts.successMessage) {
    let msg: string | undefined;
    try {
      msg = typeof opts.successMessage === 'function' ? opts.successMessage(result) : opts.successMessage;
    } catch (e) {
      // The action genuinely succeeded — a bug in the message formatter must
      // not turn that into total silence (the exact symptom WS-A targets).
      // Fall back to a generic success toast so the user still gets feedback,
      // and surface the formatter bug so it's debuggable rather than invisible.
      console.error('[runAction] successMessage formatter threw; using generic success toast', e);
      msg = 'Done';
    }
    if (msg) showToast({ message: msg, type: 'success' });
  }
  return result;
}

/** Standard catch handler for runAction callers: 401s are handled by the auth
 *  redirect, other ActionErrors were already toasted by runAction, anything
 *  else gets the fallback toast. */
export function handleActionError(err: unknown, fallback: string): void {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ message: fallback, type: 'error' });
}
