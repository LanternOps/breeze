import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Pin, Sparkles, X } from 'lucide-react';
import type { WispThreadLink } from '@breeze/shared';
import { isPinnedLink, listWispNeighbours } from '@/lib/wispLinksApi';
import { showToast } from '@/components/shared/Toast';
import { linkKey } from './wispEntitySources';

type PillProps = {
  link: WispThreadLink;
  threadId: string;
  onPin?: () => void;
  onDismiss?: () => void;
  onRemove?: () => void;
  onPinNeighbour?: (link: WispThreadLink) => void;
  linkedKeys?: ReadonlySet<string>;
  busy?: boolean;
};

type Neighbours = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; links: WispThreadLink[] };

export default function WispLinkPill(props: PillProps) {
  // A different thread or subject owns a fresh expansion and request cache.
  return <Pill key={`${props.threadId}:${linkKey(props.link.ref.kind, props.link.ref.id)}`} {...props} />;
}

function Pill({ link, onPin, onDismiss, onRemove, onPinNeighbour, linkedKeys, threadId, busy = false, expandable = true }: PillProps & { expandable?: boolean }) {
  const { t } = useTranslation('ai');
  const neighboursId = useId();
  const [expanded, setExpanded] = useState(false);
  const [neighbours, setNeighbours] = useState<Neighbours>({ status: 'idle' });
  const requested = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const key = link.id ?? linkKey(link.ref.kind, link.ref.id);
  const old = link.source === 'auto' && Date.now() - Date.parse(link.lastTouchedAt) > 24 * 60 * 60 * 1000;
  const actionClass = 'shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
  const visibleNeighbours = neighbours.status === 'ready'
    ? neighbours.links.filter((item) => !linkedKeys?.has(linkKey(item.ref.kind, item.ref.id)))
    : [];

  const toggleNeighbours = async () => {
    setExpanded((value) => !value);
    if (requested.current) return;
    requested.current = true;
    setNeighbours({ status: 'loading' });
    try {
      const links = await listWispNeighbours(threadId, link.ref);
      if (live.current) setNeighbours({ status: 'ready', links });
    } catch {
      if (!live.current) return;
      setNeighbours({ status: 'failed' });
      showToast({ type: 'error', message: t('wisp.picker.loadFailed') });
    }
  };

  return (
    <li className="min-w-0 max-w-full">
      <div data-testid={`wisp-link-chip-${key}`} data-link-kind={link.ref.kind} data-source={link.source}
        data-thread-id={threadId} data-age={old ? 'old' : 'recent'}
        className={`flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-background py-0.5 pl-2.5 pr-1 text-xs ${old ? 'opacity-60' : ''}`}>
        {link.source === 'wisp_pin' && <Sparkles className="h-3 w-3 shrink-0 text-primary" aria-label={t('wisp.links.addedByWisp')} data-testid="wisp-link-added-by-wisp" />}
        <a data-testid={`wisp-link-target-${link.ref.kind}-${link.ref.id}`} href={link.href} className="min-w-0 truncate font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{link.label}</a>
        {link.source === 'concern' && <span className="shrink-0 text-muted-foreground">{t('wisp.links.groupConcerns')}</span>}
        {link.status && <span className="shrink-0 text-[11px] text-muted-foreground">{link.status}</span>}
        {link.id !== null && isPinnedLink(link) && onRemove && <button type="button" data-testid={`wisp-link-remove-${key}`} aria-label={t('wisp.links.remove', { label: link.label })} disabled={busy} onClick={onRemove} className={actionClass}><X className="h-3 w-3" aria-hidden="true" /></button>}
        {link.source === 'auto' && <>
          {onPin && <button type="button" data-testid={`wisp-link-pin-${key}`} aria-label={t('wisp.links.pin')} disabled={busy} onClick={onPin} className={actionClass}><Pin className="h-3 w-3" aria-hidden="true" /></button>}
          {link.id !== null && onDismiss && <button type="button" data-testid={`wisp-link-dismiss-${key}`} aria-label={t('wisp.links.dismiss')} disabled={busy} onClick={onDismiss} className={actionClass}><X className="h-3 w-3" aria-hidden="true" /></button>}
        </>}
        {expandable && <button type="button" data-testid={`wisp-link-expand-${key}`} aria-label={`${t('wisp.links.neighbours')}: ${link.label}`} aria-expanded={expanded} aria-controls={neighboursId} onClick={() => void toggleNeighbours()} className={actionClass}>
          <ChevronDown className={`h-3 w-3 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>}
      </div>
      {expandable && <div id={neighboursId} hidden={!expanded} aria-busy={neighbours.status === 'loading'} className="space-y-1 py-2">
        {expanded && <>
          <p className="text-xs font-medium text-muted-foreground">{t('wisp.links.neighbours')}</p>
          {neighbours.status === 'loading' && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" role="status" aria-label={t('wisp.links.neighbours')} />}
          {neighbours.status === 'failed' && <p className="text-xs text-muted-foreground" role="status">{t('wisp.picker.loadFailed')}</p>}
          {neighbours.status === 'ready' && (visibleNeighbours.length ? <ul className="flex flex-wrap gap-1.5">
            {visibleNeighbours.map((neighbour) => <Pill key={linkKey(neighbour.ref.kind, neighbour.ref.id)} link={neighbour} threadId={threadId} expandable={false} busy={busy}
              onPin={onPinNeighbour ? () => onPinNeighbour(neighbour) : undefined} />)}
          </ul> : <p className="text-xs text-muted-foreground">{t('wisp.picker.empty')}</p>)}
        </>}
      </div>}
    </li>
  );
}
