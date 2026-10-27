/**
 * Partner branding for the Assist caller-verification card (#6354 W02),
 * served on the authenticated `/helper/config` response.
 *
 * The org comes from the helper-authenticated device and is read under the
 * request's own RLS context; only the partner id that org resolves to enters
 * the partner-axis read. No client-supplied partner id is ever accepted. The
 * logo is passed only as a credential-free https URL.
 *
 * Since #10190 (OD-2 (a)) both values come from resolvePromptIdentity: the
 * sanitized partner name, and the Settings → Partner → Branding logo (the org's
 * portal_branding logo where one is set). It used to be the partner's
 * login-page logo (partner_login_branding).
 */
import { resolvePromptIdentity } from '../promptIdentity';

export type CallerHelperBranding = { partnerName: string; logoUrl: string | null };

export function safeLogo(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export async function callerHelperBranding(orgId: string): Promise<CallerHelperBranding | null> {
  const identity = await resolvePromptIdentity(orgId);
  if (!identity?.partnerName) return null;
  return { partnerName: identity.partnerName, logoUrl: safeLogo(identity.logoSource) };
}
