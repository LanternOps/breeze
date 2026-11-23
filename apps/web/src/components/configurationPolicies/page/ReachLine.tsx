import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ConfigPolicyReach } from '../appliesTo/appliesToApi';
import type { PolicyStatus } from './PolicyHeader';

// How many devices a change on this policy reaches (spec "Save model": the
// reach line; plan W03c F3). Reach is what the caller can see (W02a): a 0
// says "no devices you can see", and a partial reach is a lower bound ("at
// least N"), never an exact-looking count.

export type ReachContext = {
  status: PolicyStatus;
  /** null = not loaded, or the read failed: no claim is made. */
  reach: ConfigPolicyReach | null;
  /** Policies based on this one that the caller can see. */
  childPolicyCount: number;
};

export type SaveReach =
  /** An active policy: its own targets plus what policies based on it reach. */
  | { kind: 'reaches'; devices: number; partial: boolean }
  /**
   * A parent whose own targets are not in force (inactive, archived, or
   * applied nowhere itself). A parent is never inert: the policies based on it
   * inherit its features whatever its status, so its saves reach their devices.
   */
  | { kind: 'in_use_through'; policies: number; devices: number; partial: boolean };

/** What a feature save on this policy reaches, or null when it says nothing (unknown, or no device changes). */
export function saveReach(ctx: ReachContext | null): SaveReach | null {
  if (!ctx || !ctx.reach) return null;
  const { status, reach, childPolicyCount } = ctx;
  const partial = reach.partial === true;
  const ownInForce = status === 'active' && (reach.direct > 0 || partial || childPolicyCount === 0);
  if (ownInForce) {
    // direct and throughChildren are disjoint (the reach service subtracts).
    return { kind: 'reaches', devices: reach.direct + reach.throughChildren, partial };
  }
  if (childPolicyCount > 0) {
    return { kind: 'in_use_through', policies: childPolicyCount, devices: reach.throughChildren, partial };
  }
  return null;
}

/** "212 devices", "at least 212 devices", or "no devices you can see". */
export function deviceCountPhrase(count: number, partial: boolean): string {
  if (partial) return i18n.t('policies:configurationPolicies.reachLine.atLeastDeviceCount', { count });
  if (count === 0) return i18n.t('policies:configurationPolicies.reachLine.noVisibleDevices');
  return i18n.t('policies:configurationPolicies.reachLine.deviceCount', { count });
}

/** "3 policies". */
export function policyCountPhrase(count: number): string {
  return i18n.t('policies:configurationPolicies.reachLine.policyCount', { count });
}

/** The reach as it follows an action: "reaches 212 devices" or "in use through 3 policies · 148 devices". */
export function reachPhrase(value: SaveReach): string {
  const devices = deviceCountPhrase(value.devices, value.partial);
  if (value.kind === 'in_use_through') {
    return i18n.t('policies:configurationPolicies.reachLine.inUseThrough', { policies: policyCountPhrase(value.policies), devices });
  }
  return i18n.t('policies:configurationPolicies.reachLine.reaches', { devices });
}

type ReachLineProps = { value: SaveReach; testId: string; className?: string };

export default function ReachLine({ value, testId, className }: ReachLineProps) {
  useTranslation('policies');
  return (
    <span data-testid={testId} className={cn('text-xs text-muted-foreground', className)}>
      {reachPhrase(value)}
    </span>
  );
}
