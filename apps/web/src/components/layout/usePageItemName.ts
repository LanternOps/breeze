import { useEffect } from 'react';
import { useRecentsStore } from '../../stores/recentsStore';

const SEPARATOR = ' · ';

// The prefix this hook currently has on `document.title`, so the recents
// recorder can read the page's own title back without it.
let activePrefix: string | null = null;

export function stripPageItemName(title: string): string {
  return activePrefix && title.startsWith(activePrefix) ? title.slice(activePrefix.length) : title;
}

/**
 * For detail pages: once the item has loaded, show its name in the browser
 * tab ("Acme Dental · Organization | Breeze RMM") and in the command
 * palette's "Recently visited" list instead of the page's id-laden path.
 * Pass `undefined` while the item is loading.
 */
export function usePageItemName(name: string | null | undefined): void {
  const namePage = useRecentsStore((s) => s.namePage);
  const trimmed = name?.trim() ?? '';

  useEffect(() => {
    if (!trimmed) return;
    const prefix = `${trimmed}${SEPARATOR}`;
    const base = stripPageItemName(document.title);
    document.title = `${prefix}${base}`;
    activePrefix = prefix;
    namePage(`${window.location.pathname}${window.location.search}`, trimmed);
    return () => {
      if (activePrefix === prefix) {
        activePrefix = null;
        if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);
      }
    };
  }, [trimmed, namePage]);
}
