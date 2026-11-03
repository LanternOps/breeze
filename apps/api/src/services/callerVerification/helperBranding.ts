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
 *
 * Since #10190 W04 (decision 1) the card also gets `logo: { sha256, mime }`:
 * the logo the heartbeat's `promptIdentity` block names for this same device.
 * The agent downloads those bytes over its own authenticated channel
 * (GET /agents/:id/prompt-identity/logo?sha256=) and syncs them to Assist,
 * which draws them on the card, so an uploaded (data:) logo shows there too.
 * `logoUrl` (https only) is unchanged for Assist builds that predate this.
 * A partner whose name sanitizes to nothing still gets null branding here
 * (the card shows "Breeze"); only endpoint-message senders take the generic
 * identity.
 */
import type { PromptLogoMime } from '../promptIdentityLogo';
import { buildHeartbeatPromptIdentity, resolvePromptIdentity, type DevicePromptIdentityArgs } from '../promptIdentity';

/** The caller-verify logo, by reference: Assist matches the sha against the bytes the agent synced. */
export type CallerHelperLogo = { sha256: string; mime: PromptLogoMime };

export type CallerHelperBranding = {
  partnerName: string;
  /** Credential-free https URL, else null. Unchanged since #6354 W02. */
  logoUrl: string | null;
  /** #10190 W04; null when there is no logo, it is invalid, or it is not resolved yet. */
  logo: CallerHelperLogo | null;
};

export function safeLogo(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Name and https logo URL. Runs in the caller's (helper request) DB context. */
export async function callerHelperBranding(orgId: string): Promise<Omit<CallerHelperBranding, 'logo'> | null> {
  const identity = await resolvePromptIdentity(orgId);
  if (identity?.partnerNameStatus !== 'usable') return null;
  return { partnerName: identity.partnerName, logoUrl: safeLogo(identity.logoSource) };
}

/**
 * The caller-verify logo reference for the helper-authenticated device: the
 * heartbeat's own resolver (buildHeartbeatPromptIdentity) and its per-device
 * cache, so the sha is exactly the one the agent was (or will next be) told.
 * That also gives:
 *
 * - tenancy: the read is keyed device → org → partner and refused (null) when
 *   the org resolves to a partner other than `partnerId`, the partner of the
 *   authenticated device's org; nothing here is ever a client value;
 * - no waiting: a cold https logo starts a background load and reads as null,
 *   exactly as the heartbeat omits its block that beat;
 * - never throws: a resolution failure is logged by the resolver and is null.
 *
 * Must be called outside any held DB context (it opens its own short system
 * read on a device-cache miss).
 */
export async function callerHelperLogo(args: DevicePromptIdentityArgs): Promise<CallerHelperLogo | null> {
  const block = await buildHeartbeatPromptIdentity(args);
  if (block?.state !== 'set' || !block.logo) return null;
  return { sha256: block.logo.sha256, mime: block.logo.mime };
}
