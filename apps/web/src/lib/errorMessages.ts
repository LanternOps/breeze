/**
 * Maps fetch errors to user-friendly messages based on error type.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  if (error instanceof Response) {
    if (error.status === 401 || error.status === 403)
      return 'Your session has expired. Please sign in again.';
    if (error.status >= 500)
      return "Something went wrong on our end. We're looking into it.";
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
  if (error instanceof Response) {
    if (error.status === 401 || error.status === 403) return 'Session expired';
    if (error.status >= 500) return 'Server error';
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
