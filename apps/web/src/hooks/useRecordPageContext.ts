import { useEffect } from 'react';
import type { AiRecordKind } from '@breeze/shared';
import { useAiStore } from '../stores/aiStore';

/** Keep the assistant anchored to the loaded record, including title edits. */
export function useRecordPageContext(ctx: {
  kind: AiRecordKind;
  id: string;
  orgId: string | null;
  label: string;
} | null): void {
  const setPageContext = useAiStore((s) => s.setPageContext);
  const kind = ctx?.kind;
  const id = ctx?.id;
  const orgId = ctx?.orgId;
  const label = ctx?.label;

  useEffect(() => {
    if (kind === undefined || id === undefined || label === undefined) return;
    setPageContext({ type: 'record', kind, id, orgId: orgId ?? undefined, label: label.slice(0, 200) });
    return () => setPageContext(null);
  }, [kind, id, orgId, label, setPageContext]);
}
