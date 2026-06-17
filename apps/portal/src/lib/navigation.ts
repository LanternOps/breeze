import { withBase } from './basePath';

interface NavigateOptions {
  replace?: boolean;
}

export async function navigateTo(path: string, options: NavigateOptions = {}): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  // Callers pass app-relative paths (e.g. "/login"); prefix the portal base path
  // so navigation works when served under /portal. withBase is idempotent and leaves
  // external URLs untouched.
  const target = withBase(path);

  try {
    const { navigate } = await import('astro:transitions/client');
    await navigate(target, {
      history: options.replace ? 'replace' : 'auto'
    });
  } catch {
    if (options.replace) {
      window.location.replace(target);
    } else {
      window.location.assign(target);
    }
  }
}
