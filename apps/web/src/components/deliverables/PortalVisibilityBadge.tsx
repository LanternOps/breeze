import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * #9960: says whether a deliverable template item will be shown in the customer
 * portal once applied (its `portalVisible`, #9315), so the template list and
 * the Apply modal answer that before anything is created.
 */
export function PortalVisibilityBadge({ visible, testId }: { visible: boolean; testId?: string }) {
  const { t } = useTranslation('deliverables');
  const Icon = visible ? Eye : EyeOff;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
        visible ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}
      data-testid={testId}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {visible ? t('templates.portal.shown') : t('templates.portal.hidden')}
    </span>
  );
}

export default PortalVisibilityBadge;
