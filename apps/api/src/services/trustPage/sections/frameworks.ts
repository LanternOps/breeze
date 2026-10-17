// Framework view selection (spec §14 W2; amendment 25). CIS v8 is gated behind BREEZE_TRUST_CIS_FRAMEWORK_VIEW
// (default OFF, Todd's §18.13 gate): while off it is never selectable or shown, and the default is NIST CSF 2.0.
import { TRUST_FRAMEWORKS, type TrustFramework } from '@breeze/shared';
import { trustCisFrameworkViewEnabled } from '../../../config/env';

function frameworkAvailable(framework: TrustFramework): boolean {
  return framework !== 'cis_v8' || trustCisFrameworkViewEnabled();
}

/** The default selection when neither the page nor the template sets one. */
export function defaultFrameworkView(): TrustFramework[] {
  return trustCisFrameworkViewEnabled() ? ['cis_v8'] : ['nist_csf_2'];
}

/** A selection as it may render: unavailable frameworks removed, canonical order, no duplicates. */
export function resolveFrameworkView(selection: readonly TrustFramework[]): TrustFramework[] {
  const chosen = new Set(selection);
  return TRUST_FRAMEWORKS.filter((fw) => frameworkAvailable(fw) && chosen.has(fw));
}

const COUNTRY_SUGGESTION: Readonly<Record<string, TrustFramework>> = {
  AU: 'essential_eight',
  GB: 'cyber_essentials',
  UK: 'cyber_essentials',
};

/** The editor's framework picker: what can be chosen, and what the partner's country suggests. */
export function frameworkOptionsFor(i: { partnerCountry: string | null }): Array<{ framework: TrustFramework; available: boolean; suggested: boolean }> {
  const suggestion = i.partnerCountry ? COUNTRY_SUGGESTION[i.partnerCountry.trim().toUpperCase()] : undefined;
  return TRUST_FRAMEWORKS.map((framework) => ({
    framework,
    available: frameworkAvailable(framework),
    suggested: framework === suggestion,
  }));
}
