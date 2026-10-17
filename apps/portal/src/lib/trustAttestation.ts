// Trust Center W3b (#8771): browser-facing paths to a page's signed attestation and the verification keys.
// Same-origin API paths (publicApiPath), so they are safe to render into public HTML.
import { publicApiPath, type PublicApiPath } from './api';

export function trustAttestationPath(partnerSlug: string, orgSlug: string | null): PublicApiPath {
  const p = encodeURIComponent(partnerSlug);
  return publicApiPath(orgSlug === null ? `/trust/attestation/${p}` : `/trust/attestation/${p}/${encodeURIComponent(orgSlug)}`);
}

export function trustAttestationJwksPath(): PublicApiPath {
  return publicApiPath('/trust/attestation/jwks.json');
}
