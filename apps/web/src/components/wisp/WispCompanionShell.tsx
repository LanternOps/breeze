import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CurrentActivity } from '@breeze/shared';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useMediaQuery } from '@/lib/useMediaQuery';
import WispRailStrip from './WispRailStrip';

/** Tailwind's `lg`: the rail sits beside the thread from here up, and collapses to the strip below. */
export const WISP_RAIL_WIDE_QUERY = '(min-width: 1024px)';

/**
 * The companion layout shared by the Wisp home and the thread page (W01
 * #10211, spec §4.1): the conversation column at reading width filling the
 * height under the shell header, and the rail at the right from `lg` up.
 * Below `lg` the rail collapses to a status strip whose Details button opens
 * it in a drawer.
 *
 * Exactly one rail is mounted at a time (aside or drawer, by media query):
 * mounting both would fetch every rail panel twice and put the `#needs-you`,
 * `#links` and `#activity` ids on the page twice.
 *
 * Height: `data-wisp-shell` turns the dashboard `<main>` into a flex column
 * (globals.css), so `flex-1` takes exactly the space left under the accent
 * strip and any banner (MFA, trust) instead of a fixed height they would push
 * below the fold. The negative bottom margin gives back main's bottom padding
 * so the composer sits near the bottom edge.
 */
export default function WispCompanionShell({
  testId,
  wisp,
  current,
  needsYouCount,
  banners,
  column,
  rail,
}: {
  testId: string;
  wisp: NonNullable<WispState>;
  current: CurrentActivity;
  needsYouCount: number;
  /** Stale and partner-disabled notices, above the column. */
  banners?: ReactNode;
  column: ReactNode;
  rail: ReactNode;
}) {
  const { t } = useTranslation('ai');
  const wide = useMediaQuery(WISP_RAIL_WIDE_QUERY);
  // The docked panel is fixed over the right 400 px on lg+: keep the rail clear of it (as /ai/chat does).
  const panelOpen = useAiStore((s) => s.isOpen);

  return (
    <div
      data-testid={testId}
      data-wisp-shell=""
      className={`-mb-4 flex min-h-[28rem] w-full flex-1 gap-6 md:-mb-6${panelOpen ? ' lg:pr-[400px]' : ''}`}
    >
      <div className="mx-auto flex min-w-0 max-w-[60rem] flex-1 flex-col gap-3">
        {banners}
        {!wide && <WispRailStrip wisp={wisp} current={current} needsYouCount={needsYouCount} rail={rail} />}
        {column}
      </div>
      {wide && (
        <aside
          aria-label={t('wisp.title')}
          data-testid="wisp-rail-aside"
          className="w-80 shrink-0 overflow-y-auto pb-4 xl:w-[22rem]"
        >
          {rail}
        </aside>
      )}
    </div>
  );
}
