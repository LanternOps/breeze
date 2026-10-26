import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import type { CurrentActivity } from '@breeze/shared';
import { Drawer } from '@/components/shared/Drawer';
import type { WispState } from '@/stores/aiStore';

/** Same dots as the identity card's state line. */
const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
};

/**
 * The rail below `lg` (W01 #10211, spec §4.1): one row under the shell header
 * with the state line (or the live "Checking …" line), how many items need
 * the user, and Details, which opens the whole rail in the shared Drawer.
 * The drawer is `w-full max-w-md`, so a phone gets it edge to edge.
 */
export default function WispRailStrip({
  wisp,
  current,
  needsYouCount,
  rail,
}: {
  wisp: NonNullable<WispState>;
  current: CurrentActivity;
  needsYouCount: number;
  rail: ReactNode;
}) {
  const { t } = useTranslation('ai');
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden" data-testid="wisp-rail-strip">
      <div className="flex items-center gap-2 rounded-lg border bg-card py-1.5 pl-3 pr-1.5">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="shrink-0 text-sm font-semibold">{t('wisp.name')}</span>
        <p
          data-testid="wisp-rail-strip-state"
          aria-live="polite"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"
        >
          {current ? (
            <>
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              <span className="truncate">
                {current.orgName ? t('wisp.live.checking', { org: current.orgName }) : t('wisp.live.checkingUnnamed')}
              </span>
            </>
          ) : (
            <>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[wisp.status] ?? 'bg-muted-foreground'}`}
                aria-hidden="true"
              />
              <span className="truncate">{t(/* i18n-dynamic */ `wisp.header.status.${wisp.status}`)}</span>
            </>
          )}
        </p>
        {needsYouCount > 0 && (
          <span
            data-testid="wisp-rail-strip-needs-you"
            className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
          >
            {t('wisp.home.needsYouCount', { count: needsYouCount })}
          </span>
        )}
        <button
          type="button"
          data-testid="wisp-rail-details"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="min-h-10 shrink-0 rounded-md border px-3 text-xs font-medium hover:bg-muted"
        >
          {t('wisp.rail.details')}
        </button>
      </div>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('wisp.name')} width="max-w-md" dataTestId="wisp-rail-drawer">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{rail}</div>
      </Drawer>
    </div>
  );
}
