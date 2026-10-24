import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';

/**
 * Tell the shortcut layer that this editor holds unsaved input. While at least
 * one dirty form is registered, `g`/`c` chords and the ticket queue's single
 * keys are ignored, so a stray keystroke cannot soft-navigate away (the
 * `beforeunload` guards do not see view-transition navigations). `?` still works.
 */
export function useRegisterDirtyForm(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    useUiStore.getState().registerDirtyForm();
    return () => useUiStore.getState().unregisterDirtyForm();
  }, [isDirty]);
}
