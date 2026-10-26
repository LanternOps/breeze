import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import type { CurrentActivity } from '@breeze/shared';
import type { WispState } from '@/stores/aiStore';

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
};

export default function WispIdentityCard({
  wisp,
  orgName,
  currentActivity,
  children,
}: {
  wisp: NonNullable<WispState>;
  orgName: string | null;
  currentActivity: CurrentActivity;
  children?: ReactNode;
}) {
  const { t } = useTranslation('ai');
  const scopeLabel = wisp.scopeOrgId === null ? t('wisp.header.scopeAll') : (orgName ?? '');

  return (
    <div data-testid="wisp-identity" className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t('wisp.name')}</h2>
          <p
            data-testid="wisp-state-line"
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            {currentActivity ? (
              <>
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                <span>
                  {currentActivity.orgName
                    ? t('wisp.live.checking', { org: currentActivity.orgName })
                    : t('wisp.live.checkingUnnamed')}
                </span>
              </>
            ) : (
              <>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[wisp.status] ?? 'bg-muted-foreground'}`}
                  aria-hidden="true"
                />
                <span>
                  {t(/* i18n-dynamic */ `wisp.header.status.${wisp.status}`)}
                  {scopeLabel ? ` · ${scopeLabel}` : ''}
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}
