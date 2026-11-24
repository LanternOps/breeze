import { createContext, useContext } from 'react';

/**
 * True when the viewer may read this policy but not change it (spec "States",
 * Viewer). The policy page provides it. FeatureTabShell then renders no
 * footer actions and a disabled form, and a control inside a tab that writes
 * on its own (not through the shell's Save) is not rendered at all.
 * Defaults to false so a tab rendered on its own (tests, other hosts) is editable.
 */
export const FeatureReadOnlyContext = createContext(false);

export function useFeatureReadOnly(): boolean {
  return useContext(FeatureReadOnlyContext);
}

/**
 * The policy page's listener for the open feature's unsaved state (plan D16).
 * FeatureTabShell reports through it; without a provider it is a no-op.
 */
export const FeatureDirtyReporterContext = createContext<(dirty: boolean) => void>(() => {});

type FeatureDirtyApi = {
  /** For a control that changes the form without a bubbling input/change event (a picker's onSelect). */
  markDirty: () => void;
};

const NOOP_DIRTY: FeatureDirtyApi = { markDirty: () => {} };

/** Provided by FeatureTabShell to its body. */
export const FeatureDirtyContext = createContext<FeatureDirtyApi>(NOOP_DIRTY);

export function useFeatureDirty(): FeatureDirtyApi {
  return useContext(FeatureDirtyContext);
}
