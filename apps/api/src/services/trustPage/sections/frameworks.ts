// Owner: W02e (framework view + BREEZE_TRUST_CIS_FRAMEWORK_VIEW gate). W02a stub — W02e replaces the bodies,
// keeping these signatures. Until then CIS v8 is treated as gated OFF (amendment 25): never selectable or shown.
import { TRUST_FRAMEWORKS, type TrustFramework } from '@breeze/shared';

/** The default selection when neither the page nor the template sets one. */
export function defaultFrameworkView(): TrustFramework[] {
  return ['nist_csf_2'];
}

/** A selection as it may render: unavailable frameworks removed, canonical order, no duplicates. */
export function resolveFrameworkView(selection: readonly TrustFramework[]): TrustFramework[] {
  const chosen = new Set(selection);
  return TRUST_FRAMEWORKS.filter((fw) => fw !== 'cis_v8' && chosen.has(fw));
}

/** The editor's framework picker. */
export function frameworkOptionsFor(_i: { partnerCountry: string | null }): Array<{ framework: TrustFramework; available: boolean; suggested: boolean }> {
  return TRUST_FRAMEWORKS.map((framework) => ({ framework, available: framework !== 'cis_v8', suggested: false }));
}
