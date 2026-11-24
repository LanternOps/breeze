import { createContext, useContext } from 'react';
import type { FeatureType } from './types';

/**
 * One-page create (plan W03d C1; spec "Create: inactive until activated").
 * On `/configuration-policies/new` every feature is browsable before the
 * policy exists. The first feature Save asks the page to create the policy
 * (inactive), then saves the feature on the new id. `useFeatureLink` is the
 * one place that does this, so no feature tab knows about create mode.
 */
export type EnsurePolicyResult =
  | { ok: true; id: string; /** True only for the call that created it. */ created: boolean }
  /** `message` null = nothing to show (a 401: the login redirect handles it). */
  | { ok: false; message: string | null };

export type PolicyCreateApi = {
  /**
   * The policy's id, creating it (inactive) on the first call. Memoised: a
   * second call, or one made while the first is in flight, never creates a
   * second policy.
   */
  ensurePolicy: () => Promise<EnsurePolicyResult>;
  /** The feature save that followed the create settled. */
  reportFirstFeatureSave: (outcome: { featureType: FeatureType; ok: boolean }) => void;
};

export const PolicyCreateContext = createContext<PolicyCreateApi | null>(null);

export function usePolicyCreate(): PolicyCreateApi | null {
  return useContext(PolicyCreateContext);
}
