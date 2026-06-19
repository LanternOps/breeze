/**
 * Reads an HTTP status off a thrown error, whether it's a `Response` (the
 * contract used by `fetchAll*` helpers, which `throw resp` on non-OK) or an
 * app error object that carries a numeric `.status` (e.g. `ActionError` from
 * `runAction`). Returns `undefined` when no status can be determined.
 */
function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof Response) return error.status;
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
}

/**
 * True when an error represents an HTTP 403 (permission denied). A 403 is a
 * permission denial, not a transient load failure or an expired session, so
 * callers should render the access-denied state (no misleading "session
 * expired / try again" UI). Robust to both `Response` and any app error object
 * carrying `status === 403`.
 */
export function isAccessDenied(error: unknown): boolean {
  return getErrorStatus(error) === 403;
}

/**
 * Maps fetch errors to user-friendly messages based on error type.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  const status = getErrorStatus(error);
  if (status !== undefined) {
    // 403 is a permission denial, not an expired session — keep them distinct
    // so we don't tell a validly-signed-in user to "sign in again."
    if (status === 403) return "You don't have permission to view this.";
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status >= 500) return "Something went wrong on our end. We're looking into it.";
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (
    msg.includes('NetworkError') ||
    msg.includes('ERR_CONNECTION') ||
    msg.includes('Failed to fetch')
  ) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  return "Couldn't load data. Try refreshing the page.";
}

/**
 * Extracts a short title from a fetch error for the error UI header.
 */
export function getErrorTitle(error: unknown): string {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'Connection error';
  }
  const status = getErrorStatus(error);
  if (status !== undefined) {
    if (status === 403) return 'Access denied';
    if (status === 401) return 'Session expired';
    if (status >= 500) return 'Server error';
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (
    msg.includes('NetworkError') ||
    msg.includes('ERR_CONNECTION') ||
    msg.includes('Failed to fetch')
  ) {
    return 'Connection error';
  }
  return 'Failed to load';
}
