import { useEffect, useRef } from 'react';
import { useRegisterDirtyForm } from '@/lib/keyboard/useRegisterDirtyForm';

/**
 * Warns before unsaved edits are discarded (spec §3.6): a click guard for links
 * (sidebar links, the Ticketing rail link), `beforeunload` for a full
 * navigation, `astro:before-preparation` for any other Astro soft navigation.
 * Follows ScriptForm's precedent.
 */
export function useUnsavedGuard(isDirty: boolean, confirmMessage: string): void {
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const messageRef = useRef(confirmMessage);
  messageRef.current = confirmMessage;
  // Keyboard navigation chords stand down while a form is dirty.
  useRegisterDirtyForm(isDirty);

  useEffect(() => {
    // Set once the user chose Leave, so the navigation that follows does not ask again.
    let leaving = false;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current && !leaving) e.preventDefault();
    };
    const onAstroNav = (e: Event) => {
      if (dirtyRef.current && !leaving && !window.confirm(messageRef.current)) e.preventDefault();
    };
    // Astro answers a cancelled astro:before-preparation with a full page load
    // (`location.href = to`), which then raises the browser's beforeunload prompt.
    // So a link click is asked about here, in the capture phase, before Astro's
    // router takes it; Cancel stops the click outright (#12622).
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || leaving || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest('a') : null;
      if (!link?.href || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const [page, fragment] = link.href.split('#');
      if (fragment !== undefined && page === location.href.split('#')[0]) return; // in-page anchor
      leaving = window.confirm(messageRef.current);
      if (!leaving) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('astro:before-preparation', onAstroNav);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('astro:before-preparation', onAstroNav);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
}
