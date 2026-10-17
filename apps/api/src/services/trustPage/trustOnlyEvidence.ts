// Owner: W02c (mfa_enforced_m365 from Microsoft 365 Conditional Access policies). W02a stub — W02c replaces the
// body, keeping this signature. Trust-page-only evidence (amendment 30): it is overlaid onto loadPostureEvidence's
// controls by the trust page build and GET /controls, never read inside loadPostureEvidence, so the posture
// report's positional query order is untouched.
import type { PostureControlEvidence } from '@breeze/shared';
import type { PostureEvidencePolicy } from '../postureEvidence';

export async function loadTrustOnlyEvidence(
  _orgId: string,
  _asOf: Date,
  _policy: PostureEvidencePolicy,
): Promise<Partial<PostureControlEvidence>> {
  return {};
}
