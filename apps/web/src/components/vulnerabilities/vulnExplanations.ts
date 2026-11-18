/**
 * One source of truth for the plain-language score explanations on the fleet
 * vulnerabilities page — column-header tooltips, drawer title attrs, and the
 * KEV badge all pull from here so the phrasing can't drift.
 *
 * RISK_EXPLANATION must track the actual formula in
 * apps/api/src/services/vulnerabilityRiskScore.ts (computeRiskScore): CVSS×10
 * is the spine, EPSS adds up to 10 points, and KEV CVEs are floored to 80 then
 * nudged +5 — so a known-exploited CVE never scores below 85.
 */

export const RISK_EXPLANATION =
  'Breeze priority score (0–100): the CVSS score scaled to 100, plus a bump for exploitation likelihood (EPSS). Known-exploited (KEV) CVEs never score below 85. Higher = fix sooner.';

export const CVSS_EXPLANATION =
  'Industry-standard severity score (0–10) for how damaging exploitation would be — not how likely it is.';

export const EPSS_EXPLANATION =
  'Likelihood of exploitation in the next 30 days (FIRST.org EPSS).';

export const KEV_EXPLANATION =
  "On CISA's Known Exploited Vulnerabilities catalog — actively exploited in the wild.";

/**
 * The one definition of "is there a patch?" on the page (#9533). The By-software
 * Patch column, the By-CVE Patch column and the "Patch ready" tile all use it;
 * "Ready" is exactly what Remediate installs (apps/api/src/services/
 * vulnerabilityRemediation.ts resolveRemediationTargets).
 */
export const PATCH_EXPLANATION =
  'Ready: a managed patch is pending on the device and approved — Remediate installs it. Update to latest: the vendor has a fix but no approved managed patch is pending; update the software directly. —: no fix is known yet.';
