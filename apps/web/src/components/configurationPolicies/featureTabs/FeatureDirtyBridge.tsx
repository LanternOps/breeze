import { useEffect, type MutableRefObject } from "react";
import { useFeatureDirty } from "./featureEditing";

/**
 * FeatureTabShell provides `useFeatureDirty()` to its children, not to the tab
 * component that renders it. A tab whose own handler changes the form without a
 * click or input event (a drag-and-drop reorder) renders this inside the shell
 * and calls `markDirtyRef.current()` from the handler (#12469).
 */
export default function FeatureDirtyBridge({
  markDirtyRef,
}: {
  markDirtyRef: MutableRefObject<() => void>;
}) {
  const { markDirty } = useFeatureDirty();
  useEffect(() => {
    markDirtyRef.current = markDirty;
    return () => {
      markDirtyRef.current = () => {};
    };
  }, [markDirty, markDirtyRef]);
  return null;
}
