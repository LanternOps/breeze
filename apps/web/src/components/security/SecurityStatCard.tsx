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
}

export default function SecurityStatCard({
  icon: Icon,
  label,
  value,
  variant = 'default',
  detail
}: SecurityStatCardProps) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="rounded-full border bg-muted/30 p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={cn('text-xl font-semibold', variantStyles[variant])}>
            {value}
          </p>
          {detail && (
            <p className="text-xs text-muted-foreground">{detail}</p>
          )}
        </div>
      </div>
    </div>
  );
}
