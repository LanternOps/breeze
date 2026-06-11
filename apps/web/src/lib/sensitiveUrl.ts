export function scrubQueryParamsFromCurrentUrl(paramNames: string[]): void {
  if (typeof window === 'undefined' || paramNames.length === 0) return;

  const url = new URL(window.location.href);
  let changed = false;

  for (const name of paramNames) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }

  if (!changed) return;

  const scrubbed = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, '', scrubbed);
}
