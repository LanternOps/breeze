import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ConfigPolicyReach } from './appliesToApi';

// A policy's device count (#12467). Reach is what the caller can see, so a 0
// says "no devices you can see", never "not applied" (that state comes from
// the applies-to summary's unfiltered count). A partial reach is a lower
// bound: "at least N", never N.

type ReachCountProps = {
  reach: ConfigPolicyReach;
  /** 'direct' for the policy's own targets; 'throughChildren' for a parent applied only through its children. */
  count: 'direct' | 'throughChildren';
  testId: string;
  className?: string;
};

export default function ReachCount({ reach, count, testId, className }: ReachCountProps) {
  const { t } = useTranslation('policies');
  const n = reach[count];
  const text =
    n === 0 && !reach.partial
      ? t('configurationPolicies.reachCount.noneVisible')
      : reach.partial
        ? t('configurationPolicies.reachCount.atLeastDevices', { count: n })
        : t('configurationPolicies.reachCount.devices', { count: n });
  return (
    <span data-testid={testId} className={cn('text-xs text-muted-foreground', className)}>
      {text}
    </span>
  );
}
