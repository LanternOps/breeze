import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type FeatureLockProps = {
  /** false ⇒ renders children only. */
  locked: boolean;
  /** The registry `why` line for the gated feature. */
  why: string;
  /** Where the upsell CTA points. Default '/settings/plan'. */
  upgradeHref?: string;
  /** Base test id; the caption and CTA get `-why` / `-cta` suffixes. Default 'feature-lock'. */
  testId?: string;
  children: ReactNode;
};

/**
 * Locked-with-upsell affordance for an entitlement-gated surface. A locked
 * surface stays visible (so the partner can see what an upgrade adds) but is
 * wrapped in a disabled fieldset, followed by the `why` line and a CTA to the
 * Plan & features page. Pair with `useEntitlement(key)`: render it locked only
 * when the state is `'locked'` — `'loading'` is neither locked nor enabled:
 * render the surface's own loading state, and when `failed` is true a retry
 * (`reload()`) instead of an endless spinner. The server-side gate
 * (`requireEntitlement`) is the enforcement; this is the affordance.
 */
export function FeatureLock({
  locked,
  why,
  upgradeHref = '/settings/plan',
  testId = 'feature-lock',
  children,
}: FeatureLockProps) {
  const { t } = useTranslation('common');

  if (!locked) return <>{children}</>;

  return (
    <div data-testid={testId} data-locked="true">
      {/* `disabled` only covers form controls; links and click-handled
          elements inside a disabled fieldset stay live, so swallow clicks in
          the capture phase before they reach any child handler. */}
      <fieldset
        disabled
        className="opacity-60 cursor-not-allowed"
        aria-disabled="true"
        onClickCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </fieldset>
      <p
        className="mt-1 flex items-center gap-1 text-xs italic text-amber-600 dark:text-amber-400"
        data-testid={`${testId}-why`}
      >
        <Lock size={12} aria-label={t('featureLock.lockedLabel')} />
        <span>{why}</span>
        <a href={upgradeHref} className="font-medium not-italic underline" data-testid={`${testId}-cta`}>
          {t('featureLock.upgrade')}
        </a>
      </p>
    </div>
  );
}

export default FeatureLock;
