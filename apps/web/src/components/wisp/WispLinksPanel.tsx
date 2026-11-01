import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Plus, Sparkles, X } from 'lucide-react';
import { WISP_THREAD_LINK_LIMIT, type WispThreadLink } from '@breeze/shared';
import { isPinnedLink, removeWispLink } from '@/lib/wispLinksApi';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import WispEntityPicker from './WispEntityPicker';
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
  const linkedKeys = useMemo(() => new Set(links.map((l) => linkKey(l.ref.kind, l.ref.id))), [links]);
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
    // The add is idempotent server-side: a re-add returns the existing row
    // (with a refreshed label), so replace by id rather than append twice.
    const exists = links.some((l) => l.id === link.id);
    onLinksChange(exists ? links.map((l) => (l.id === link.id ? link : l)) : [...links, link]);
    setPickerOpen(false);
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
        <ul className="flex flex-wrap gap-1.5">
          {links.map((link) => (
            <li
              key={link.id ?? linkKey(link.ref.kind, link.ref.id)}
              data-testid={`wisp-link-chip-${link.id ?? linkKey(link.ref.kind, link.ref.id)}`}
              data-link-kind={link.ref.kind}
              className="flex max-w-full items-center gap-1 rounded-full border bg-background py-0.5 pl-2.5 pr-1 text-xs"
            >
              {link.source === 'wisp_pin' && (
                <Sparkles className="h-3 w-3 shrink-0 text-primary" aria-label={t('wisp.links.addedByWisp')} data-testid="wisp-link-added-by-wisp" />
              )}
              <a href={link.href} className="truncate font-medium hover:underline">{link.label}</a>
              {link.status && <span className="shrink-0 text-[11px] text-muted-foreground">{link.status}</span>}
              {link.id !== null && <button
                type="button"
                data-testid={`wisp-link-remove-${link.id ?? linkKey(link.ref.kind, link.ref.id)}`}
                aria-label={t('wisp.links.remove', { label: link.label })}
                disabled={removingId !== null}
                onClick={() => void remove(link)}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>}
            </li>
          ))}
        </ul>
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
