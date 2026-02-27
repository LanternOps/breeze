interface NavigateOptions {
  replace?: boolean;
}

export async function navigateTo(path: string, options: NavigateOptions = {}): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const { navigate } = await import('astro:transitions/client');
    await navigate(path, {
      history: options.replace ? 'replace' : 'auto'
    });
  } catch {
    if (options.replace) {
      window.location.replace(path);
    } else {
      window.location.assign(path);
    }
  }
}
