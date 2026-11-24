import type { FeatureLink } from './types';

/**
 * The one footer action a feature offers (#12263, spec "Policy page": one rule
 * for all 26 features).
 * - `reset_to_parent`: this policy has its own link and its parent has the
 *   feature too. Deleting the own link brings back the parent's settings.
 * - `remove`: only this policy has the feature. Deleting the link returns the
 *   feature to Not set. A child policy whose parent lacks the feature gets
 *   Remove too, not a Reset that would reset to nothing.
 * - null: nothing of its own to delete (inherited, or not set).
 *
 * It keys on the parent's link for THIS feature, never on whether the policy
 * has a parent at all.
 */
export type FeatureEditAction = 'remove' | 'reset_to_parent';

export function featureEditAction(
  own: FeatureLink | undefined,
  parent: FeatureLink | undefined,
): FeatureEditAction | null {
  if (!own) return null;
  return parent ? 'reset_to_parent' : 'remove';
}

type Handler = () => void | Promise<unknown>;

/**
 * The footer props a tab passes to FeatureTabShell: exactly one of `onRemove`
 * and `onRevert`, or neither. `reset` defaults to `remove` for tabs whose
 * Reset to parent is the same delete.
 */
export function featureEditProps(
  own: FeatureLink | undefined,
  parent: FeatureLink | undefined,
  handlers: { remove: Handler; reset?: Handler },
): { onRemove?: () => void; onRevert?: () => void } {
  const action = featureEditAction(own, parent);
  if (action === 'remove') return { onRemove: handlers.remove as () => void };
  if (action === 'reset_to_parent') return { onRevert: (handlers.reset ?? handlers.remove) as () => void };
  return {};
}
