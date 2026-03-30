import { cn } from '../../lib/utils';

type AlphaBadgeProps = {
  /** Short label shown in the badge. Default: "Alpha" */
  label?: string;
  /** Optional disclaimer text shown below or beside the badge */
  disclaimer?: string;
  /** Render as inline badge (default) or full-width banner */
  variant?: 'badge' | 'banner';
  className?: string;
};

const defaultDisclaimer =
  'This feature is in early access. Functionality may change, and some operations may not work as expected. Not recommended for production use without testing.';

/**
 * Alpha badge / banner for features that are functional but not yet
 * production-hardened. Use on enterprise backup features (MSSQL, Hyper-V,
 * C2C, DR, Vault, SLA, Instant Boot, VM Restore).
 */
export default function AlphaBadge({
  label = 'Alpha',
  disclaimer,
  variant = 'badge',
  className,
}: AlphaBadgeProps) {
  if (variant === 'banner') {
    return (
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3',
          className,
        )}
      >
        <span className="mt-0.5 inline-flex shrink-0 items-center rounded-md bg-warning/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-warning">
          {label}
        </span>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {disclaimer ?? defaultDisclaimer}
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
      title={disclaimer ?? defaultDisclaimer}
    >
      {label}
    </span>
  );
}
