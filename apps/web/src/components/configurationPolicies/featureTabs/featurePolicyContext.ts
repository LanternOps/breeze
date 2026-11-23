import { createContext, useContext } from 'react';
import type { ReachContext } from '../page/ReachLine';

/**
 * Facts about the open policy that every feature tab's shell states (plan
 * W03c F3; spec "Save model" and "Inheritance display"). The policy page
 * provides it; without a provider (tests, other hosts) the shell makes no
 * reach claim and names no parent.
 */
export type FeaturePolicyInfo = {
  /** What a feature save reaches; null = not known. */
  reach: ReachContext | null;
  /** The parent policy, for "From <parent> · Open". href null = the caller may not open it. */
  parent: { name: string; href: string | null } | null;
};

export const FeaturePolicyContext = createContext<FeaturePolicyInfo | null>(null);

export function useFeaturePolicy(): FeaturePolicyInfo | null {
  return useContext(FeaturePolicyContext);
}
