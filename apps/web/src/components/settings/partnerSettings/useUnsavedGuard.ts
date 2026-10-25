import { useEffect, useRef } from 'react';
import { useRegisterDirtyForm } from '@/lib/keyboard/useRegisterDirtyForm';

/**
 * Warns before unsaved edits are discarded (spec §3.6): `beforeunload` for a
 * full navigation, `astro:before-preparation` for an Astro soft navigation
 * (sidebar links, the Ticketing rail link). Follows ScriptForm's precedent.
 */
export function useUnsavedGuard(isDirty: boolean, confirmMessage: string): void {
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const messageRef = useRef(confirmMessage);
  messageRef.current = confirmMessage;
  // Keyboard navigation chords stand down while a form is dirty.
  useRegisterDirtyForm(isDirty);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    const onAstroNav = (e: Event) => {
      if (dirtyRef.current && !window.confirm(messageRef.current)) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('astro:before-preparation', onAstroNav);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('astro:before-preparation', onAstroNav);
    };
  }, []);
}
