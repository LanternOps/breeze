// Trust Center W3b (#8771): signed, machine-readable copy of a published trust page, plus its JWKS.
//
// SECURITY: NO auth middleware. Every DB op runs inside runOutsideDbContext(() => withSystemDbAccessContext(...))
// (in this file or in the key service). The admission order and the generic 404 are W1's (routes/trustPagePublic.ts,
// spec trust-center §7, §13), rebuilt here from the exported building blocks so neither file depends on the other:
// slug regex (no Redis) → serving set (no Postgres) → ONE indexed resolve. Every non-serving case is the same
// uncacheable 404. The token signs the CURRENT immutable snapshot payload; posture is never computed here.
//
// Rate limit: the isolated global bucket 'trustattest' (middleware/globalRateLimit.ts). Cross-origin: CORP
// `cross-origin` is applied at the secureHeaders registration (middleware/trustCrossOrigin.ts); the middleware
// below sets `Access-Control-Allow-Origin: *` and removes the credentialed-CORS header the app-wide cors() adds.
import { Hono, type Context } from 'hono';
import { decodeJwt } from 'jose';
import { normalizeTrustPagePayload, type TrustPagePublicPayload } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isServing, readCachedSnapshotPayload, cacheSnapshotPayload, trustServingMember } from '../services/trustPage/servingSet';
import { parseTrustSlugs, resolvePublishedTrustPage, type ResolvedTrustPage } from '../services/trustPage/resolve';
import {
  ensureActiveTrustSigningKey,
  loadTrustJwks,
  TrustAttestationUnavailable,
  TRUST_JWKS_MAX_AGE_SECONDS,
} from '../services/trustPage/attestationKeys';
import {
  signTrustAttestation,
  trustAttestationIssuer,
  trustCanonicalPageUrl,
  TrustAttestationStale,
} from '../services/trustPage/attestation';

export const trustPageAttestationRoutes = new Hono();

const GENERIC_404 = { error: 'Not found', code: 'NOT_FOUND' } as const;
const ATTESTATION_MAX_AGE_SECONDS = 60;
const STALE_RETRY_AFTER_SECONDS = 3600;

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const notFound = (c: Context) => c.json(GENERIC_404, 404);
const unavailable = (c: Context) => c.json({ error: 'Temporarily unavailable', code: 'SERVICE_UNAVAILABLE' }, 503);
const stale = (c: Context) => {
  c.header('Retry-After', String(STALE_RETRY_AFTER_SECONDS));
  return c.json({ error: 'No current attestation: the page has not been evaluated in the last 24 hours', code: 'ATTESTATION_STALE' }, 503);
};

// Every response, errors included (a verifier in a browser must be able to read ATTESTATION_STALE):
// - readable from any origin, never with credentials — the app-wide cors() runs with credentials: true and echoes
//   allowlisted origins, which must not carry over to an unauthenticated public resource;
// - every non-200 is uncacheable — the generic 404, the 503s and an unexpected error alike: a page published, an
//   operator's key activation or an evaluation a minute later must not stay hidden behind a proxy cache.
trustPageAttestationRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', '*');
  c.res.headers.delete('Access-Control-Allow-Credentials');
  if (c.res.status !== 200) c.res.headers.set('Cache-Control', 'no-store');
});

// ---- JWKS. Declared first; '.' fails the slug regex, so no partner slug can collide with it.
trustPageAttestationRoutes.get('/jwks.json', async (c) => {
  try {
    await ensureActiveTrustSigningKey(); // provisions on a fresh deployment so the first JWKS is never empty
  } catch (err) {
    // No signer (revoked without --replace): still publish the verify-only keys for archival verification.
    if (!(err instanceof TrustAttestationUnavailable)) throw err;
    console.warn(`[trustAttestation] jwks: no active signer, serving the published keys only: ${err.message}`);
  }
  const jwks = await loadTrustJwks();
  if (jwks.keys.length === 0) {
    console.warn('[trustAttestation] jwks: no publishable keys (every key revoked); answering 503');
    return unavailable(c);
  }
  c.header('Content-Type', 'application/jwk-set+json');
  c.header('Cache-Control', `public, max-age=${TRUST_JWKS_MAX_AGE_SECONDS}`);
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(JSON.stringify(jwks), 200);
});

/** W1 admission without the card's "Redis unknown → 503" branch: this path is rate-limited, so it falls through. */
async function admit(c: Context, partnerSlug: string, orgSlug: string | undefined): Promise<{ resolved: ResolvedTrustPage; slugs: { partnerSlug: string; orgSlug: string | null } } | Response> {
  const slugs = parseTrustSlugs(partnerSlug, orgSlug);
  if (!slugs) return notFound(c);
  const serving = await isServing(trustServingMember(slugs.partnerSlug, slugs.orgSlug ?? undefined));
  if (serving === false) return notFound(c);
  const resolved = await sys(() => resolvePublishedTrustPage(slugs.partnerSlug, slugs.orgSlug));
  return resolved ? { resolved, slugs } : notFound(c);
}

async function payloadFor(r: ResolvedTrustPage): Promise<TrustPagePublicPayload | null> {
  if (!r.snapshotId) return null;
  // Same normalization as the public payload route: a stored v1 snapshot is signed in its v2 shape, so the
  // attestation always carries exactly what the public page serves (W02a payload v2).
  const cached = await readCachedSnapshotPayload(r.snapshotId);
  if (cached) return normalizeTrustPagePayload(cached);
  if (r.payload) { await cacheSnapshotPayload(r.snapshotId, r.payload); return normalizeTrustPagePayload(r.payload); }
  return null;
}

async function attestation(c: Context, partnerSlug: string, orgSlug?: string) {
  const admitted = await admit(c, partnerSlug, orgSlug);
  if (admitted instanceof Response) return admitted;
  const { resolved, slugs } = admitted;
  const payload = await payloadFor(resolved);
  if (!payload) return notFound(c);

  let token: string;
  try {
    const canonicalUrl = trustCanonicalPageUrl(trustAttestationIssuer(), slugs.partnerSlug, slugs.orgSlug);
    token = await signTrustAttestation({ resolved, payload, canonicalUrl });
  } catch (err) {
    if (err instanceof TrustAttestationStale) return stale(c);
    if (err instanceof TrustAttestationUnavailable) {
      console.warn(`[trustAttestation] unavailable: ${err.message}`);
      return unavailable(c);
    }
    throw err;
  }

  // A cache must never hold the token past its exp (and the token cache leaves ≥ 60 s on a hit).
  const exp = decodeJwt(token).exp ?? 0;
  const maxAge = Math.max(0, Math.min(ATTESTATION_MAX_AGE_SECONDS, exp - Math.floor(Date.now() / 1000)));
  c.header('Content-Type', 'application/jwt');
  c.header('Cache-Control', `public, max-age=${maxAge}`);
  c.header('X-Robots-Tag', 'noindex');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(token, 200);
}

trustPageAttestationRoutes.get('/:partnerSlug', (c) => attestation(c, c.req.param('partnerSlug')));
trustPageAttestationRoutes.get('/:partnerSlug/:orgSlug', (c) => attestation(c, c.req.param('partnerSlug'), c.req.param('orgSlug')));

// Registered LAST: anything else under the prefix is the same generic 404, never a fall-through to other routers.
trustPageAttestationRoutes.all('/*', (c) => notFound(c));
