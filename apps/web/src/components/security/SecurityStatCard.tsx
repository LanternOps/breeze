import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'success' | 'warning' | 'danger';

const variantStyles: Record<Variant, string> = {
  default: 'text-foreground',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  danger: 'text-red-600'
};

interface SecurityStatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  variant?: Variant;
  detail?: string;
  /** Calm skeleton while the stat is being fetched — distinct from the
   *  "—" placeholder, which callers reserve for missing/failed data. */
  loading?: boolean;
}

export default function SecurityStatCard({
  icon: Icon,
  label,
  value,
  variant = 'default',
  detail,
  loading = false
}: SecurityStatCardProps) {
  return (
    <div className="h-full rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-3">
        <div className="rounded-full border bg-muted/30 p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          {loading ? (
            <div className="py-1.5" aria-hidden="true" data-testid="stat-card-skeleton">
              <div className="h-5 w-10 rounded bg-muted motion-safe:animate-pulse" />
            </div>
          ) : (
            <>
              <p className={cn('text-xl font-semibold', variantStyles[variant])}>
                {value}
              </p>
              {detail && (
                <p className="text-xs text-muted-foreground">{detail}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
