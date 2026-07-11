import { cn } from '../../lib/utils';
import { useTranslation } from 'react-i18next';

type AlphaBadgeProps = {
  /** Short label shown in the badge. Default: "Alpha" */
  label?: string;
  /** Optional disclaimer text shown below or beside the badge */
  disclaimer?: string;
  /** Render as inline badge (default) or full-width banner */
  variant?: 'badge' | 'banner';
  className?: string;
};

/**
 * Alpha badge / banner for features that are functional but not yet
 * production-hardened. Use on enterprise backup features (MSSQL, Hyper-V,
 * C2C, DR, Vault, SLA, Instant Boot, VM Restore).
 */
export default function AlphaBadge({
  label,
  disclaimer,
  variant = 'badge',
  className,
}: AlphaBadgeProps) {
  const { t } = useTranslation('common');
  const resolvedLabel = label ?? t('shared.alpha.label');
  const resolvedDisclaimer = disclaimer ?? t('shared.alpha.disclaimer');
  if (variant === 'banner') {
    return (
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3',
          className,
        )}
      >
        <span className="mt-0.5 inline-flex shrink-0 items-center rounded-md bg-warning/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-warning">
          {resolvedLabel}
        </span>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {resolvedDisclaimer}
        </p>
      </div>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md bg-warning/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-warning',
        className,
      )}
      title={resolvedDisclaimer}
    >
      {resolvedLabel}
    </span>
  );
}
