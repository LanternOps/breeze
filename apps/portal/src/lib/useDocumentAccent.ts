import { useEffect, type RefObject } from 'react';
import { sanitizeAccentColor } from './docAccent';

/**
 * Deliver a partner accent to a client-fetched document (the public invoice,
 * D17). SSR pages get `--doc-accent` from the layout's nonced <style>; a page
 * that learns the colour after hydration cannot, so the variable is written
 * through CSSOM on the host wrapper. `style-src-attr 'none'` governs `style`
 * attributes, not `style.setProperty`; the W1 Playwright slice proves it under
 * the production CSP. The wrapper, not <html>: ClientRouter navigations replace
 * the attributes on <html>.
 */
export function useDocumentAccent(ref: RefObject<HTMLElement | null>, color: string | null | undefined): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const safe = sanitizeAccentColor(color);
    if (safe) el.style.setProperty('--doc-accent', safe);
    else el.style.removeProperty('--doc-accent');
  }, [ref, color]);
}
