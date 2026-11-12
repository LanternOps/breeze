/**
 * Provider-neutral portal OIDC types (portal registration W4; W7 adds
 * Google). Nothing here is Entra-shaped except `entraTenantId`, which is null
 * for a provider without tenants, and nothing Google-shaped except
 * `googleHostedDomain`.
 */

export type PortalOidcProvider = 'entra' | 'google';

/**
 * Why a flow was started. The single public callback dispatches on it (D4).
 * Every field is server-chosen at start and travels only inside the stored
 * state, never through the browser.
 */
export type PortalOidcPurpose =
  | { kind: 'login' }
  /** sha256 of the invite capability token the start request presented. */
  | { kind: 'invite'; inviteTokenHash: string }
  /** The signed-in portal account linking an identity, pinned to its session's epoch. */
  | { kind: 'link'; portalUserId: string; orgId: string; authEpoch: number }
  /** sha256 of the proof-run link token; the tenant the link is pinned to (D6: a run always is). */
  | { kind: 'tenant_proof'; runTokenHash: string; orgId: string; expectedTenantId: string };

/** The stored flow state. Never holds the raw `state` or binding value, only the binding's sha256. */
export interface PortalOidcState {
  v: 1;
  provider: PortalOidcProvider;
  purpose: PortalOidcPurpose;
  nonce: string;
  codeVerifier: string;
  /** sha256 (hex) of the browser-binding cookie value. */
  bindingHash: string;
  /** The org whose verified custom domain served the start request, or null on the shared host (D5). */
  hostOrgId: string | null;
  /** Entra: `organizations` or a tenant GUID. Google: exactly `PORTAL_GOOGLE_ISSUER`. */
  authority: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * A verified identity from a provider's id_token: a union keyed on `provider`,
 * so a consumer that narrows to one provider gets that provider's guarantees
 * (a Google identity always carries its `hd`).
 *
 * Field names match ClientAiEntraClaims (services/clientAiEntraJwt.ts) so
 * resolveLinkableEntraAddress (services/clientAiEntraAddress.ts) can read it
 * structurally: `upn` is the address-shaped `preferred_username`, lowercased;
 * `emailClaim` is the raw `email` claim, lowercased, trusted only together
 * with `emailDomainOwnerVerified` and NEVER a linking key (inv. 5).
 */
interface PortalOidcVerifiedIdentityBase {
  provider: PortalOidcProvider;
  issuer: string;
  subject: string;
  entraTenantId: string | null;
  upn: string | null;
  emailClaim: string | null;
  emailDomainOwnerVerified: boolean;
  name: string | null;
}

/** services/portalOidc/entraClient.ts. The W4 shape, unchanged. */
export interface PortalEntraVerifiedIdentity extends PortalOidcVerifiedIdentityBase {
  provider: 'entra';
  /** Exactly `entraIssuer(tid)`. */
  issuer: string;
  /** The `oid` claim, never `sub`. */
  subject: string;
  /** Declared (never set) so code can read the field on the union. */
  googleHostedDomain?: undefined;
}

/** services/portalOidc/googleClient.ts (W7, plan D1). */
export interface PortalGoogleVerifiedIdentity extends PortalOidcVerifiedIdentityBase {
  provider: 'google';
  /** Exactly `PORTAL_GOOGLE_ISSUER`, whichever of Google's two `iss` forms the token carried. */
  issuer: string;
  /** The `sub` claim exactly as issued (case-sensitive, never normalized). */
  subject: string;
  entraTenantId: null;
  /** Google has no `preferred_username`. */
  upn: null;
  /** The `hd` claim, lowercased: the only input that chooses an org (D2). Never the authorize hint. */
  googleHostedDomain: string;
}

export type PortalOidcVerifiedIdentity = PortalEntraVerifiedIdentity | PortalGoogleVerifiedIdentity;
