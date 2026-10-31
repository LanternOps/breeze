import { useTranslation } from 'react-i18next';
import { Pin, Sparkles, X } from 'lucide-react';
import type { WispThreadLink } from '@breeze/shared';
import { isPinnedLink } from '@/lib/wispLinksApi';
import { linkKey } from './wispEntitySources';

export default function WispLinkPill({ link, onPin, onDismiss, onRemove, threadId, busy = false }: {
  link: WispThreadLink;
  threadId: string;
  onPin?: () => void;
  onDismiss?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('ai');
  const key = link.id ?? linkKey(link.ref.kind, link.ref.id);
  const old = link.source === 'auto' && Date.now() - Date.parse(link.lastTouchedAt) > 24 * 60 * 60 * 1000;
  const actionClass = 'shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
  return (
    <li data-testid={`wisp-link-chip-${key}`} data-link-kind={link.ref.kind} data-source={link.source}
      data-thread-id={threadId} data-age={old ? 'old' : 'recent'}
      className={`flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-background py-0.5 pl-2.5 pr-1 text-xs ${old ? 'opacity-60' : ''}`}>
      {link.source === 'wisp_pin' && <Sparkles className="h-3 w-3 shrink-0 text-primary" aria-label={t('wisp.links.addedByWisp')} data-testid="wisp-link-added-by-wisp" />}
      <a href={link.href} className="min-w-0 truncate font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{link.label}</a>
      {link.source === 'concern' && <span className="shrink-0 text-muted-foreground">{t('wisp.links.groupConcerns')}</span>}
      {link.status && <span className="shrink-0 text-[11px] text-muted-foreground">{link.status}</span>}
      {link.id !== null && isPinnedLink(link) && onRemove && <button type="button" data-testid={`wisp-link-remove-${key}`} aria-label={t('wisp.links.remove', { label: link.label })} disabled={busy} onClick={onRemove} className={actionClass}><X className="h-3 w-3" aria-hidden="true" /></button>}
      {link.id !== null && link.source === 'auto' && <>
        {onPin && <button type="button" data-testid={`wisp-link-pin-${key}`} aria-label={t('wisp.links.pin')} disabled={busy} onClick={onPin} className={actionClass}><Pin className="h-3 w-3" aria-hidden="true" /></button>}
        {onDismiss && <button type="button" data-testid={`wisp-link-dismiss-${key}`} aria-label={t('wisp.links.dismiss')} disabled={busy} onClick={onDismiss} className={actionClass}><X className="h-3 w-3" aria-hidden="true" /></button>}
      </>}
    </li>
  );
}
