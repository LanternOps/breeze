import { getSafeNext } from './authNext';

interface NavigateOptions {
  replace?: boolean;
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
    await navigate(safePath, {
      history: options.replace ? 'replace' : 'auto'
    });
  } catch {
    if (options.replace) {
      window.location.replace(safePath);
    } else {
      window.location.assign(safePath);
    }
  }
}
