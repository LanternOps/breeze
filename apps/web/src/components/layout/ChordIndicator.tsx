import { useTranslation } from 'react-i18next';
import { CREATE_SHORTCUTS, GO_TO_SHORTCUTS, type ChordPrefix } from '../../lib/keyboard/goToShortcuts';

/**
 * Which-key style hint shown while a chord prefix (`g`, `c`) is waiting for
 * its second key: the pressed key plus every key that can complete it. Purely
 * visual — the chord itself is handled by `useGlobalShortcuts`.
 */
export default function ChordIndicator({ prefix }: { prefix: ChordPrefix | null }) {
  const { t } = useTranslation('common');
  if (!prefix) return null;

  const options = prefix === 'g' ? GO_TO_SHORTCUTS : CREATE_SHORTCUTS;
  const heading = prefix === 'g' ? t('layout.shortcuts.goTo') : t('layout.shortcuts.create');

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="chord-indicator"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
    >
      <div className="max-w-2xl rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg">
        <div className="mb-2 flex items-center gap-2">
          <kbd className="inline-flex min-w-7 items-center justify-center rounded border border-primary bg-primary px-1.5 py-0.5 font-mono text-xs font-semibold uppercase text-primary-foreground">
            {prefix}
          </kbd>
          <span className="font-medium">{heading}…</span>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {options.map((o) => (
            <li key={o.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <kbd className="inline-flex min-w-5 items-center justify-center rounded border bg-muted px-1 py-0.5 font-mono text-[11px] font-semibold uppercase text-foreground">
                {o.key}
              </kbd>
              <span>{t(/* i18n-dynamic */ o.labelKey)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
