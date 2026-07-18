// apps/web/src/components/shared/ScopeBadge.tsx
import { Building2, Layers, Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

// One quiet badge that states a catalog record's audience. Calm, not loud —
// muted surface, brand accent only for the partner-wide case (the one a tech
// most needs to notice: "this is shared across all my customers").
export function ScopeBadge({
  orgId,
  partnerId,
  isSystem,
  orgName,
  className,
}: {
  orgId: string | null;
  partnerId: string | null;
  isSystem: boolean;
  orgName?: string;
  className?: string;
}) {
  const { t } = useTranslation('common');
  let icon = <Building2 className="h-3 w-3" />;
  let label = orgName ?? t('labels.organization');
  let tone = 'bg-muted text-muted-foreground';

  if (isSystem) {
    icon = <Package className="h-3 w-3" />;
    label = t('shared.scope.system');
  } else if (orgId === null && partnerId !== null) {
    // Layers, not Globe: the Globe is reserved for the VIEW scope (the header's
    // All-organizations fleet view). Ownership is a different axis and must not
    // wear the same icon.
    icon = <Layers className="h-3 w-3" />;
    label = t('shared.scope.partnerWide');
    tone = 'bg-primary/10 text-primary';
  }

  return (
    <span
      data-testid="scope-badge"
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone, className)}
    >
      {icon}
      {label}
    </span>
  );
}
