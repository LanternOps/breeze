import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * "Change for this policy" on an inherited feature (spec "Inheritance
 * display"; plan W03c F2). The tab shows the parent's values locked; Change
 * for this policy unlocks the form WITHOUT writing, and the tab's normal Save
 * creates this policy's own link. Leaving without saving writes nothing.
 *
 * The unlock lives in the tab, not only in FeatureTabShell, because a tab's
 * own body (a fieldset, a row editor) is rendered by the tab and must unlock
 * with the shell. When the feature stops being inherited (a Save made the
 * policy's own link) the unlock is dropped, so a later Reset to parent lands
 * on the locked parent view again.
 */
export function useChangeForPolicy(inherited: boolean) {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    if (!inherited) setUnlocked(false);
  }, [inherited]);
  const unlock = useCallback(() => setUnlocked(true), []);
  const open = inherited && unlocked;
  return useMemo(
    () => ({
      /** True while the tab shows the parent's values and may not be edited. */
      locked: inherited && !open,
      /** Spread into FeatureTabShell. */
      shellProps: { unlocked: open, onUnlock: unlock },
    }),
    [inherited, open, unlock],
  );
}
