import { create } from 'zustand';
import { getDocsForPath, DOCS_BASE_URL } from '@breeze/shared';
import { isDocsUrl } from '@/lib/safeHref';

interface HelpState {
  isOpen: boolean;
  docsUrl: string;
  label: string;

  toggle: () => void;
  open: (url?: string) => void;
  close: () => void;
}

export const useHelpStore = create<HelpState>((set) => ({
  isOpen: false,
  docsUrl: DOCS_BASE_URL,
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

    // Only a url whose ORIGIN exactly matches the docs site may be written into
    // docsUrl, which is consumed as an <iframe src>. This is an origin check
    // (via isDocsUrl), not a string-prefix match, so docs-lookalike hosts such
    // as docs.breezermm.com.evil.com are rejected. Any untrusted value falls
    // back to the safe contextual docs page for the current path.
    if (isDocsUrl(url)) {
      set({ isOpen: true, docsUrl: url, label: 'Documentation' });
    } else {
      const { url: resolved, label } = getDocsForPath(window.location.pathname);
      set({ isOpen: true, docsUrl: resolved, label });
    }
  },

  close: () => set({ isOpen: false }),
}));
