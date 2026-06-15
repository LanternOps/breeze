import { create } from 'zustand';
import { getDocsForPath, DOCS_BASE_URL } from '@breeze/shared';
import { isDocsUrl } from '@/lib/safeHref';
import { configuredDocsOrigin } from '@/lib/docsEmbed';

interface HelpState {
  isOpen: boolean;
  docsUrl: string;
  label: string;

  toggle: () => void;
  open: (url?: string) => void;
  close: () => void;
}

/**
 * Rebase a docs URL built from the canonical `DOCS_BASE_URL` onto a self-hosted
 * docs origin when `PUBLIC_DOCS_URL` is configured. The docs path map lives in
 * `@breeze/shared` and is hard-coded to the hosted origin; self-hosters serve
 * the same content at their own origin, so we keep the resolved path/query/hash
 * and only swap the origin. Returns the input unchanged when no docs origin is
 * configured or the swap can't be performed.
 */
export function rebaseDocsUrl(url: string, docsOrigin: string | null = configuredDocsOrigin()): string {
  if (!docsOrigin) return url;
  try {
    const canonical = new URL(DOCS_BASE_URL).origin;
    const parsed = new URL(url);
    if (parsed.origin !== canonical) return url;
    return `${docsOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export const useHelpStore = create<HelpState>((set) => ({
  isOpen: false,
  docsUrl: rebaseDocsUrl(DOCS_BASE_URL),
  label: 'Documentation',

  toggle: () => {
    const state = useHelpStore.getState();
    if (state.isOpen) {
      state.close();
    } else {
      state.open();
    }
  },

  open: (url?: string) => {
    // Lazy import to avoid circular dependency with aiStore
    import('./aiStore')
      .then(({ useAiStore }) => useAiStore.getState().close())
      .catch((err) => console.warn('[HelpStore] Failed to close AI panel:', err));

    // Only a url whose ORIGIN exactly matches a trusted docs site may be written
    // into docsUrl, which is consumed as an <iframe src>. This is an origin check
    // (via isDocsUrl), not a string-prefix match, so docs-lookalike hosts such
    // as docs.breezermm.com.evil.com are rejected. isDocsUrl trusts both the
    // canonical hosted origin and a self-hosted origin from PUBLIC_DOCS_URL, so
    // a caller-supplied self-hosted docs link is accepted as-is. Any untrusted
    // value falls back to the safe contextual docs page for the current path,
    // rebased onto the self-hosted docs origin when one is configured.
    if (isDocsUrl(url)) {
      set({ isOpen: true, docsUrl: url, label: 'Documentation' });
    } else {
      const { url: resolved, label } = getDocsForPath(window.location.pathname);
      set({ isOpen: true, docsUrl: rebaseDocsUrl(resolved), label });
    }
  },

  close: () => set({ isOpen: false }),
}));
