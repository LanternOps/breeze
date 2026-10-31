import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Plus } from 'lucide-react';
import { WISP_THREAD_LINK_LIMIT, type WispThreadLink } from '@breeze/shared';
import { isPinnedLink, removeWispLink, pinWispLink } from '@/lib/wispLinksApi';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import WispEntityPicker from './WispEntityPicker';
import WispLinkPill from './WispLinkPill';
import { linkKey } from './wispEntitySources';

/**
 * The Breeze objects linked to the Wisp thread (W08 Task 9, w00 A35). Every
 * link here was re-resolved by the server on this read (label, status, href
 * come from the entity, never a cached row), so the panel renders what it is
 * given and only mutates through the links API. Removing needs no live grant;
 * adding does (`canAdd` false while paused or ended — the server would 409).
 */
export default function WispLinksPanel({
  threadId,
  links,
  onLinksChange,
  canAdd = true,
}: {
  threadId: string;
  links: WispThreadLink[];
  onLinksChange: (links: WispThreadLink[]) => void;
  canAdd?: boolean;
}) {
  const { t } = useTranslation('ai');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const linkedKeys = useMemo(() => new Set(links.filter((l) => l.id !== null).map((l) => linkKey(l.ref.kind, l.ref.id))), [links]);
  const groups = [
    { id: 'pinned', title: 'groupPinned', items: links.filter(isPinnedLink) },
    { id: 'concerns', title: 'groupConcerns', items: links.filter((l) => l.source === 'concern') },
    { id: 'recent', title: 'groupRecent', items: links.filter((l) => l.source === 'auto') },
  ];
  let remaining = expanded ? links.length : 12;
  const pinCount = links.filter(isPinnedLink).length;
  const atLimit = pinCount >= WISP_THREAD_LINK_LIMIT;

  const remove = async (link: WispThreadLink) => {
    if (removingId || link.id === null) return;
    setRemovingId(link.id);
    try {
      await removeWispLink(threadId, link.id);
      onLinksChange(links.filter((l) => l.id !== link.id));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wisp.links.removeFailed') }); // ActionError already toasted
    } finally {
      setRemovingId(null);
    }
  };

  const onLinked = (link: WispThreadLink) => {
    const key = linkKey(link.ref.kind, link.ref.id);
    const exists = links.some((l) => linkKey(l.ref.kind, l.ref.id) === key);
    onLinksChange(exists ? links.map((l) => (linkKey(l.ref.kind, l.ref.id) === key ? link : l)) : [...links, link]);
    setPickerOpen(false);
  };

  const pin = async (link: WispThreadLink) => {
    if (removingId || link.id === null || !canAdd || atLimit) return;
    setRemovingId(link.id);
    try {
      onLinked(await pinWispLink(threadId, link.id));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wisp.links.addFailed') });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section id="links" className="space-y-2 px-4 py-3" data-testid="wisp-links-panel" aria-labelledby="wisp-links-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="wisp-links-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <Link2 className="h-4 w-4" aria-hidden="true" />
          {t('wisp.links.title')}
        </h2>
        <div className="flex items-center gap-2">
          {links.length > 0 && (
            <span className="text-[11px] text-muted-foreground" data-testid="wisp-links-count">
              {t('wisp.links.count', { count: pinCount, max: WISP_THREAD_LINK_LIMIT })}
            </span>
          )}
          <button
            type="button"
            data-testid="wisp-links-add"
            disabled={!canAdd || atLimit}
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('wisp.links.add')}
          </button>
        </div>
      </div>

      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="wisp-links-empty">{t('wisp.links.empty')}</p>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => {
            const visible = group.items.slice(0, remaining);
            remaining -= visible.length;
            if (!visible.length) return null;
            return <div key={group.id} data-testid={`wisp-links-group-${group.id}`}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t(`wisp.links.${group.title}`)}</h3>
              <ul className="flex flex-wrap gap-1.5">
                {visible.map((link) => <WispLinkPill key={linkKey(link.ref.kind, link.ref.id)} threadId={threadId} link={link}
                  busy={removingId !== null} onRemove={() => void remove(link)} onDismiss={() => void remove(link)}
                  onPin={canAdd && !atLimit ? () => void pin(link) : undefined} />)}
              </ul>
            </div>;
          })}
          {!expanded && links.length > 12 && <button type="button" data-testid="wisp-links-more" onClick={() => setExpanded(true)} className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted">{t('wisp.links.more')}</button>}
        </div>
      )}

      <WispEntityPicker
        open={pickerOpen}
        threadId={threadId}
        linkedKeys={linkedKeys}
        onClose={() => setPickerOpen(false)}
        onLinked={onLinked}
      />
    </section>
  );
}
