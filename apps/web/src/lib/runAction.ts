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

  const result = (opts.parseSuccess ? opts.parseSuccess(data) : (data as T));
  if (opts.successMessage) {
    const msg = typeof opts.successMessage === 'function'
      ? opts.successMessage(result)
      : opts.successMessage;
    showToast({ message: msg, type: 'success' });
  }
  return result;
}
