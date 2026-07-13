import { getSafeNext } from './authNext';

interface NavigateOptions {
  replace?: boolean;
  /** Rechecked after asynchronous module loading and before any fallback. */
  guard?: () => boolean;
}

export async function navigateTo(path: string, options: NavigateOptions = {}): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  // Guard against open-redirect: callers may pass server-supplied values
  // (e.g. notification/command `href`). Only allow same-origin relative paths;
  // anything else falls back to '/'.
  const safePath = getSafeNext(path, '/');

  try {
    const { navigate } = await import('astro:transitions/client');
    if (options.guard && !options.guard()) return;
    await navigate(safePath, {
      history: options.replace ? 'replace' : 'auto'
    });
  } catch {
    if (options.guard && !options.guard()) return;
    if (options.replace) {
      window.location.replace(safePath);
    } else {
      window.location.assign(safePath);
    }
  }
}
