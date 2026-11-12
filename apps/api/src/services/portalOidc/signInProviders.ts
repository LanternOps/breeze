/**
 * Portal OIDC sign-in provider adapters (portal registration W7 #11384, plan
 * D4): everything provider-specific about resolving a verified identity to a
 * portal account. `resolvePortalOidcSignIn` (./accountResolution.ts) keeps ONE
 * resolution order (spec §5.6 steps 0–5) and asks the adapter, selected
 * server-side from the verified identity's `provider` (never from request
 * input), for:
 *  - the org (step 0): Entra → the PROVEN tenant mapping;
 *  - the proof fence a write branch holds for its transaction (D15);
 *  - the identity key used for lookup, touch and link;
 *  - the legacy-column pre-check before an invite is spent (W3 D4 / W4 D11);
 *  - the new person's address and contact rule (W4 D10);
 *  - the session pin and the access-request input.
 *
 * This module writes nothing: every portal write stays in the resolver (the
 * writer census, __tests__/portalAccountWriters.contract.test.ts).
 */
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { resolveLinkableEntraAddress } from '../clientAiEntraAddress';
import type { CreatePortalAccessRequestInput } from '../portalAccessRequests';
import { findOrgByProvenEntraTenant } from '../portalEntraTenantProof';
import { entraIssuer, type PortalIdentityKey } from '../portalUserIdentities';
import type { PortalEntraVerifiedIdentity, PortalOidcProvider, PortalOidcVerifiedIdentity } from './types';

/** What a browser session is pinned to; the session gate re-checks it per request. */
export interface PortalOidcSessionPin {
  entraTenantId: string | null;
  googleHostedDomain: string | null;
}

/** A new person's address (step 4). */
export interface PortalOidcNewPersonAddress {
  /** The account or request address. */
  email: string;
  /** The address a contact may be linked through, or null for no contact link. */
  contactAddress: string | null;
  /** Any account in the org at one of these is `account_exists`, never a link (inv. 5). */
  refuseIfAnyAccountAt: string[];
}

/** The org step 0 resolved and, for a domain-proven provider, the `verified_at` it observed. */
export interface PortalOidcResolvedOrg {
  orgId: string;
  proofVerifiedAt: Date | null;
}

export interface PortalOidcSignInProvider {
  provider: PortalOidcProvider;
  /** Step 0's org. Null → `org_unresolved`. No DB context held. */
  resolveOrg(identity: PortalOidcVerifiedIdentity): Promise<PortalOidcResolvedOrg | null>;
  /** D15: called first inside a write branch's transaction; false → the branch refuses `org_unresolved`. */
  fenceProof(org: PortalOidcResolvedOrg, identity: PortalOidcVerifiedIdentity): Promise<boolean>;
  identityKey(identity: PortalOidcVerifiedIdentity): PortalIdentityKey;
  /** Whether a login holds this identity on legacy `portal_users` columns (read before an invite is spent). */
  legacyKeyHeld(identity: PortalOidcVerifiedIdentity): Promise<boolean>;
  /** Null → `no_address`. No DB context held. */
  newPersonAddress(
    identity: PortalOidcVerifiedIdentity,
    org: { orgId: string; partnerId: string },
  ): Promise<PortalOidcNewPersonAddress | null>;
  sessionPin(identity: PortalOidcVerifiedIdentity): PortalOidcSessionPin;
  accessRequest(
    identity: PortalOidcVerifiedIdentity,
    base: { orgId: string; email: string; name: string | null },
  ): CreatePortalAccessRequestInput;
}

/** The adapter is selected from the identity's provider; a mismatch is a programming error, never a fallback. */
function asEntra(identity: PortalOidcVerifiedIdentity): PortalEntraVerifiedIdentity & { entraTenantId: string } {
  if (identity.provider !== 'entra' || typeof identity.entraTenantId !== 'string') {
    throw new Error('entraSignInProvider: not an Entra identity');
  }
  return identity as PortalEntraVerifiedIdentity & { entraTenantId: string };
}

// ---------------------------------------------------------------------------
// Entra (W4, moved unchanged)
// ---------------------------------------------------------------------------

export const entraSignInProvider: PortalOidcSignInProvider = {
  provider: 'entra',

  async resolveOrg(identity) {
    // The verifier guarantees this; refuse rather than trust a mismatched shape.
    if (identity.provider !== 'entra' || !identity.entraTenantId || identity.issuer !== entraIssuer(identity.entraTenantId)) {
      return null;
    }
    // Only a PROVEN tenant mapping resolves an org (inv. 2).
    const org = await findOrgByProvenEntraTenant(identity.entraTenantId);
    return org ? { orgId: org.orgId, proofVerifiedAt: null } : null;
  },

  // A tenant transfer is serialized by W4's own proof transaction (advisory
  // lock, then an epoch bump of the displaced org's tenant identities).
  async fenceProof() {
    return true;
  },

  identityKey(identity) {
    const entra = asEntra(identity);
    return { provider: 'entra', tid: entra.entraTenantId, oid: entra.subject };
  },

  /**
   * Whether any login holds `(tid, oid)` on its legacy `portal_users
   * (entra_tenant_id, entra_oid)` columns (the W3 D4 writer fence keeps them
   * until identities release C). A login with those columns and no identity row
   * (drift the daily reconcile only reports) is invisible to step 1, yet
   * `linkPortalUserIdentity` refuses it as a conflict — so the invite step reads
   * it BEFORE spending the invite. This also refuses the edge where the invited
   * account itself is the drifted holder: the invite is not known until it is
   * consumed, and an unspent invite plus a generic refusal is the safe side.
   */
  async legacyKeyHeld(identity) {
    const entra = asEntra(identity);
    const [holder] = await withSystemDbAccessContext(
      () => db
        .select({ id: portalUsers.id })
        .from(portalUsers)
        .where(and(eq(portalUsers.entraTenantId, entra.entraTenantId), eq(portalUsers.entraOid, entra.subject)))
        .limit(1),
      'portalOidc.resolve.legacyEntraKey',
    );
    return Boolean(holder);
  },

  async newPersonAddress(identity, org) {
    const entra = asEntra(identity);
    // D10: the email is the linkable address (the existing contact rule), else
    // the lowercased UPN (always on a tenant-verified domain).
    const linkable = await withSystemDbAccessContext(
      () => resolveLinkableEntraAddress(org.orgId, org.partnerId, entra),
      'portalOidc.resolve.address',
    );
    const linkableEmail = linkable.kind === 'linkable' ? linkable.email.trim().toLowerCase() : null;
    const upn = entra.upn?.trim().toLowerCase() || null;
    const email = linkableEmail ?? upn;
    if (!email) return null;
    return {
      email,
      // D10: a contact link only for a linkable address.
      contactAddress: linkableEmail,
      // An account at either address is a refusal, never a link (inv. 5).
      refuseIfAnyAccountAt: [...new Set([email, upn, linkableEmail].filter((a): a is string => Boolean(a)))],
    };
  },

  sessionPin(identity) {
    return { entraTenantId: asEntra(identity).entraTenantId, googleHostedDomain: null };
  },

  accessRequest(identity, base) {
    const entra = asEntra(identity);
    return { source: 'entra', ...base, tid: entra.entraTenantId, oid: entra.subject };
  },
};

/** The adapter for a verified identity's provider. Throws for a provider without one. */
export function signInProviderFor(provider: PortalOidcProvider): PortalOidcSignInProvider {
  if (provider === 'entra') return entraSignInProvider;
  throw new Error(`portal OIDC sign-in: no adapter for provider ${String(provider)}`);
}
