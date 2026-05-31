import { create } from 'zustand';
import { getDocsForPath, DOCS_BASE_URL } from '@breeze/shared';

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

    // Only a docs-prefixed url may be written into docsUrl, which is consumed
    // as an <iframe src>. Any untrusted value falls back to the safe
    // contextual docs page for the current path.
    if (url && DOCS_BASE_URL && url.startsWith(DOCS_BASE_URL)) {
      set({ isOpen: true, docsUrl: url, label: 'Documentation' });
    } else {
      const { url: resolved, label } = getDocsForPath(window.location.pathname);
      set({ isOpen: true, docsUrl: resolved, label });
    }
  },

  close: () => set({ isOpen: false }),
}));
