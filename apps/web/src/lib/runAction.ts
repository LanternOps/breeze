import { showToast } from '../components/shared/Toast';
import { extractApiError, isApiFailure } from './apiError';

export class ActionError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
  }
}

export interface RunActionOptions<T> {
  request: () => Promise<Response>;
  errorFallback: string;
  successMessage?: string | ((data: T) => string);
  parseSuccess?: (data: unknown) => T;
  friendly?: (code: string) => string | undefined;
  onUnauthorized?: () => void;
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
  if (response.status === 401) {
    if (opts.onUnauthorized) opts.onUnauthorized();
    throw new ActionError('Unauthorized', 401);
  }

  const data: unknown = await response.json().catch(() => null);

  if (isApiFailure(data, response.status)) {
    let message = extractApiError(data, opts.errorFallback);
    const code = (data && typeof data === 'object'
      ? (data as Record<string, unknown>).code
      : undefined) as string | undefined;
    if (code && opts.friendly) {
      const friendly = opts.friendly(code);
      if (friendly) message = friendly;
    }
    showToast({ message, type: 'error' });
    throw new ActionError(message, response.status, code);
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
    } catch {
      msg = undefined;
    }
    if (msg) showToast({ message: msg, type: 'success' });
  }
  return result;
}
