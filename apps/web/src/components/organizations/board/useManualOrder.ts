import { useCallback, useState, type DragEvent, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { runAction } from '@/lib/runAction';

export interface ManualOrderApi {
  /** True from the PATCH until reconciliation settles. Dragging is disabled and
   *  keyboard moves are ignored meanwhile, which SERIALISES reorders: every
   *  stale-order race needs a second move to overlap the first request. */
  reorderPending: boolean;
  /** Last keyboard move, read out by the page's polite live region. */
  announcement: string;
  draggedOrgId: string | null;
  dragOverOrgId: string | null;
  onDragStart: (event: DragEvent<HTMLElement>, org: Organization) => void;
  onDragOver: (event: DragEvent<HTMLElement>, org: Organization) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>, target: Organization) => void;
  onDragEnd: () => void;
  /** Keyboard reorder: one step up or down. Ignored, not hidden, while a PATCH is in flight. */
  move: (org: Organization, delta: -1 | 1) => void;
}

export interface UseManualOrderOptions {
  organizations: Organization[];
  setOrganizations: Dispatch<SetStateAction<Organization[]>>;
  /** Authoritative silent re-read after a failed PATCH (must not blank the page). */
  refetch: () => Promise<void>;
}

function moveItem(list: Organization[], sourceIndex: number, targetIndex: number): Organization[] {
  const next = [...list];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function useManualOrder({ organizations, setOrganizations, refetch }: UseManualOrderOptions): ManualOrderApi {
  const { t } = useTranslation('organizations');
  const [reorderPending, setReorderPending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [draggedOrgId, setDraggedOrgId] = useState<string | null>(null);
  const [dragOverOrgId, setDragOverOrgId] = useState<string | null>(null);

  const persist = useCallback(
    async (orderedIds: string[]) => {
      setReorderPending(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth('/orgs/organizations/order', { method: 'PATCH', body: JSON.stringify({ orderedIds }) }),
          errorFallback: t('orgBoard.errors.saveOrder'),
          onUnauthorized: handleSessionExpired,
        });
      } catch {
        // Only the server knows what persisted: runAction collapses a lost
        // response and a rejected PATCH to the same throw, so re-read rather
        // than restore a local snapshot (which would lie in one direction or
        // the other). `reorderPending` keeps a second drag from overlapping
        // this GET. The error toast already fired inside runAction.
        await refetch();
      } finally {
        setReorderPending(false);
      }
    },
    [refetch, t],
  );

  const reorder = useCallback(
    (sourceId: string, targetId: string, announce: boolean) => {
      const sourceIndex = organizations.findIndex((o) => o.id === sourceId);
      const targetIndex = organizations.findIndex((o) => o.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return;
      const next = moveItem(organizations, sourceIndex, targetIndex);
      setOrganizations(next);
      if (announce) {
        setAnnouncement(
          t('orgBoard.reorder.moved', { name: organizations[sourceIndex].name, position: targetIndex + 1, total: next.length }),
        );
      }
      void persist(next.map((o) => o.id));
    },
    [organizations, persist, setOrganizations, t],
  );

  const onDragStart = useCallback((event: DragEvent<HTMLElement>, org: Organization) => {
    setDraggedOrgId(org.id);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set or the drag never fires.
    try {
      event.dataTransfer.setData('text/plain', org.id);
    } catch {
      /* jsdom / older engines without a DataTransfer store */
    }
  }, []);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>, org: Organization) => {
      if (!draggedOrgId || draggedOrgId === org.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dragOverOrgId !== org.id) setDragOverOrgId(org.id);
    },
    [draggedOrgId, dragOverOrgId],
  );

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    // Only clear when leaving the row entirely, not when entering a child.
    const related = event.relatedTarget as Node | null;
    if (!related || !(event.currentTarget as Node).contains(related)) setDragOverOrgId(null);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>, target: Organization) => {
      event.preventDefault();
      setDragOverOrgId(null);
      const sourceId = draggedOrgId;
      setDraggedOrgId(null);
      if (!sourceId || reorderPending) return;
      reorder(sourceId, target.id, false);
    },
    [draggedOrgId, reorder, reorderPending],
  );

  const onDragEnd = useCallback(() => {
    setDraggedOrgId(null);
    setDragOverOrgId(null);
  }, []);

  const move = useCallback(
    (org: Organization, delta: -1 | 1) => {
      if (reorderPending) return;
      const index = organizations.findIndex((o) => o.id === org.id);
      if (index === -1) return;
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= organizations.length) return;
      reorder(org.id, organizations[targetIndex].id, true);
    },
    [organizations, reorder, reorderPending],
  );

  return { reorderPending, announcement, draggedOrgId, dragOverOrgId, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, move };
}
