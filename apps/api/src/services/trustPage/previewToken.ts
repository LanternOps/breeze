import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { buildHeader, getSignKey, getVerifyKey } from '../jwt';

const ISSUER = 'breeze';
const AUDIENCE = 'breeze-trust-preview';
const PURPOSE = 'trust-preview';
export const TRUST_PREVIEW_TTL_SECONDS = 15 * 60;

/** Short-lived, purpose- and audience-bound token that lets an editor render an unpublished trust page. */
export async function createTrustPreviewToken(input: { pageId: string; orgId: string }): Promise<string> {
  const signKey = getSignKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ pageId: input.pageId, orgId: input.orgId, purpose: PURPOSE })
    .setProtectedHeader(buildHeader(signKey.kid))
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + TRUST_PREVIEW_TTL_SECONDS)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(signKey.key);
}

export async function verifyTrustPreviewToken(token: string): Promise<{ pageId: string; orgId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.purpose !== PURPOSE || typeof payload.pageId !== 'string' || typeof payload.orgId !== 'string') return null;
    return { pageId: payload.pageId, orgId: payload.orgId };
  } catch {
    return null;
  }
}
