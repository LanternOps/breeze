import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';
import { Dialog } from '../shared/Dialog';
import {
  decideWhatsNew,
  markSeen,
  latestApplicableEntry,
  LAST_SEEN_KEY,
} from '../../lib/whatsNewState';
import type { WhatsNewEntry } from '../../lib/whatsNew';

export const REOPEN_EVENT = 'breeze:whats-new:open';

export default function WhatsNewSplash() {
  const { t } = useTranslation('common');
  const [entry, setEntry] = useState<WhatsNewEntry | null>(null);
  const [open, setOpen] = useState(false);

  // Decide once on mount (post-hydration; initial render is null → no SSR mismatch).
  useEffect(() => {
    const decision = decideWhatsNew(window.localStorage);
    if (decision.baselineToSet) {
      window.localStorage.setItem(LAST_SEEN_KEY, decision.baselineToSet);
      return;
    }
    if (decision.entry) {
      setEntry(decision.entry);
      setOpen(true);
    }
  }, []);

  // Reopen from the sidebar link (separate island → window-event bridge).
  useEffect(() => {
    const onReopen = () => {
      const e = latestApplicableEntry();
      if (e) {
        setEntry(e);
        setOpen(true);
      }
    };
    window.addEventListener(REOPEN_EVENT, onReopen);
    return () => window.removeEventListener(REOPEN_EVENT, onReopen);
  }, []);

  if (!entry) return null;

  const gotIt = () => {
    markSeen(window.localStorage, entry.version);
    setOpen(false);
  };
  // Dialog onClose fires on Esc / backdrop → treated as "show me later".
  const later = () => setOpen(false);

  return (
    <Dialog
      open={open}
      onClose={later}
      title={t('whatsNew.title', { version: entry.version })}
      labelledBy="whats-new-heading"
      maxWidth="lg"
      className="p-6"
    >
      <h2 id="whats-new-heading" className="text-lg font-semibold">
        {t('whatsNew.title', { version: entry.version })}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{entry.title}</p>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {entry.highlights.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      {entry.learnMoreUrl && (
        <a
          href={entry.learnMoreUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-sm text-primary hover:underline"
        >
          {t('whatsNew.learnMore')}
        </a>
      )}
      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={later}
          className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          {t('whatsNew.later')}
        </button>
        <button
          type="button"
          onClick={gotIt}
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('whatsNew.gotIt')}
        </button>
      </div>
    </Dialog>
  );
}
