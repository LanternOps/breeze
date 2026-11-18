/**
 * One answer to "what does this MSP look like on a device" (#10190, spec §3.6,
 * plan Task 3.2; settings rule 5). Used by device prompts (the heartbeat's
 * `promptIdentity` block and the logo route), endpoint-message sender
 * snapshots (endpointMessaging/brandingSnapshot.ts) and the caller-verify card
 * (callerVerification/helperBranding.ts).
 *
 * - `partnerName` is `partners.name` through sanitizePromptPartnerName. It is
 *   NEVER taken from the org or portal_branding: an org-level writer must not
 *   choose who a prompt appears to come from (#9396). A name that sanitizes to
 *   nothing is omitted (the renderer shows its localized generic name).
 * - Logo and colour come from `partners.settings.branding` (Settings → Partner
 *   → Branding), overridden field by field by the org's portal_branding row
 *   through resolveDocumentBrand. An override that is not usable (a colour that
 *   is not hex, a logo that is neither data: nor https://) falls back to the
 *   partner's value rather than to nothing.
 * - `scopeId` = first 32 hex of sha256("<partnerId>:<orgId>"): changes on an
 *   org move or a partner change, which tells the agent to drop the identity
 *   and the prompt-list entries made under the old one.
 *
 * Tenancy: the org row and portal_branding are read under the caller's own
 * context; the partner row (partner-axis) through readWithPartnerAxisVisibility,
 * pinned to the partner id the org row resolved to. No caller-supplied partner
 * id is ever read. Agent paths (resolveDevicePromptIdentity) run the read in a
 * system context of their own, outside any held one, with the org id from the
 * authenticated device, and refuse an answer for any partner other than the
 * authenticated agent's.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { promptIdentityBlockSchema, sanitizePromptPartnerName, type PromptIdentityBlock } from '@breeze/shared/promptCatalog';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners, portalBranding } from '../db/schema';
import { readDevicePolicyCache, writeDevicePolicyCache } from './devicePolicyCache';
import { partnerDocumentBrand, resolveDocumentBrand } from './partnerDocumentBrand';
import {
  loadPromptIdentityLogo,
  peekPromptIdentityLogo,
  promptLogoSourceKey,
  readCachedPromptLogo,
  type PromptLogo,
} from './promptIdentityLogo';

export const PROMPT_IDENTITY_CACHE_TTL_SECONDS = 120;

interface PromptIdentityBase {
  /** Server-side only; never on the wire. */
  partnerId: string;
  orgId: string;
  scopeId: string;
  /** `#RRGGBB`. */
  primaryColor?: string;
  /** A `data:` or `https://` URL; validated only when loaded (promptIdentityLogo.ts). */
  logoSource?: string;
}

/**
 * `partnerNameStatus` tells "the partner exists but its name sanitized to
 * nothing" (a real partner row; `partnerName` absent) apart from a usable
 * name. "No partner at all" is the resolver returning null. Device prompts
 * omit the name either way (the renderer shows its localized generic name);
 * endpoint-message senders use the generic identity for `sanitized_empty`
 * and fail closed on null (#10190 W04, decision 2).
 */
export type PromptIdentity = PromptIdentityBase & (
  | { partnerNameStatus: 'usable'; partnerName: string }
  | { partnerNameStatus: 'sanitized_empty'; partnerName?: never }
);

export function promptIdentityScopeId(partnerId: string, orgId: string): string {
  return createHash('sha256').update(`${partnerId}:${orgId}`).digest('hex').slice(0, 32);
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/** `#RRGGBB` (a `#rgb` value is expanded; same colour), else null. */
function wireColor(value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  if (HEX6.test(v)) return v;
  if (HEX3.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

function usableLogo(value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.startsWith('data:') || v.startsWith('https://') ? v : null;
}

/**
 * The MSP identity for `orgId`, or null when the org is not visible or its
 * partner row cannot be read. A partner whose name sanitizes to nothing is
 * NOT null: it resolves with `partnerNameStatus: 'sanitized_empty'`.
 * Uncached; runs in the caller's DB context.
 */
export async function resolvePromptIdentity(orgId: string): Promise<PromptIdentity | null> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = org?.partnerId;
  if (!partnerId) return null;

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ name: partners.name, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1),
  );
  if (!partner) return null;

  const [orgBrand] = await db
    .select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);

  const resolved = resolveDocumentBrand(orgBrand ?? undefined, partner.settings);
  const fallback = partnerDocumentBrand(partner.settings);
  const primaryColor = wireColor(resolved.primaryColor) ?? wireColor(fallback.primaryColor);
  const logoSource = usableLogo(resolved.logoUrl) ?? usableLogo(fallback.logoUrl);
  const partnerName = sanitizePromptPartnerName(partner.name ?? '');

  return {
    partnerId,
    orgId,
    scopeId: promptIdentityScopeId(partnerId, orgId),
    ...(partnerName
      ? { partnerNameStatus: 'usable' as const, partnerName }
      : { partnerNameStatus: 'sanitized_empty' as const }),
    ...(primaryColor ? { primaryColor } : {}),
    ...(logoSource ? { logoSource } : {}),
  };
}

/** A device's resolved identity, as cached (no logo bytes, no source URL). */
export type DevicePromptIdentity =
  | { state: 'cleared' }
  | {
    state: 'set';
    partnerId: string;
    scopeId: string;
    partnerName?: string;
    primaryColor?: string;
    logo?: { sha256: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: number };
    /** sha256 of the logo source: the logo cache key (promptIdentityLogo.ts). */
    logoSourceKey?: string;
  };

export class PromptIdentityPartnerMismatchError extends Error {
  constructor(readonly deviceId: string) {
    super(`device ${deviceId}: prompt identity resolved to a partner other than the authenticated agent's`);
    this.name = 'PromptIdentityPartnerMismatchError';
  }
}

function parseCached(value: unknown): DevicePromptIdentity {
  const v = value as DevicePromptIdentity | null;
  if (!v || (v.state !== 'set' && v.state !== 'cleared')) throw new Error('malformed prompt-identity cache entry');
  if (v.state === 'set' && (typeof v.partnerId !== 'string' || typeof v.scopeId !== 'string')) {
    throw new Error('malformed prompt-identity cache entry');
  }
  return v;
}

export interface DevicePromptIdentityArgs {
  /** The authenticated device. */
  deviceId: string;
  /** The authenticated device's org (verified by the caller). */
  orgId: string;
  /** The authenticated agent's partner; any other answer is refused. */
  partnerId: string | null | undefined;
  /** Skip the per-device cache read (the logo route's re-check after a miss). */
  skipCacheRead?: boolean;
}

/**
 * How the logo is obtained on a device-cache miss.
 * - `await`: load it, fetching an https source if needed (bounded by the
 *   logo loader's overall deadline). The logo route uses this.
 * - `warm`: never wait on the network. A cold https logo starts a background
 *   load and the identity is reported as pending (null): the heartbeat omits
 *   the block that beat, so the agent keeps its last-known identity and logo,
 *   and the next beat finds the logo cached. Sending the block WITHOUT `logo`
 *   instead would tell the agent "no logo" and blank a logo it already has
 *   every time the logo cache expires.
 */
type LogoMode = 'await' | 'warm';

async function resolveDeviceIdentity(args: DevicePromptIdentityArgs, mode: LogoMode): Promise<DevicePromptIdentity | null> {
  const { deviceId, orgId, partnerId } = args;
  if (!args.skipCacheRead) {
    const cached = await readDevicePolicyCache('prompt-identity', deviceId, orgId, parseCached);
    if (cached) {
      if (cached.state === 'set' && cached.partnerId !== partnerId) throw new PromptIdentityPartnerMismatchError(deviceId);
      return cached;
    }
  }

  const identity = await runOutsideDbContext(() => withSystemDbAccessContext(() => resolvePromptIdentity(orgId)));
  let result: DevicePromptIdentity;
  if (!identity) {
    result = { state: 'cleared' };
  } else {
    if (identity.partnerId !== partnerId) throw new PromptIdentityPartnerMismatchError(deviceId);
    const logoCtx = { partnerId: identity.partnerId };
    let logo: PromptLogo | null = null;
    if (identity.logoSource && mode === 'await') {
      logo = await loadPromptIdentityLogo(identity.logoSource, logoCtx);
    } else if (identity.logoSource) {
      const peek = await peekPromptIdentityLogo(identity.logoSource, logoCtx);
      // Not cached: the next beat re-resolves and finds the warmed logo.
      if (peek.state === 'pending') return null;
      logo = peek.state === 'ready' ? peek.logo : null;
    }
    result = {
      state: 'set',
      partnerId: identity.partnerId,
      scopeId: identity.scopeId,
      ...(identity.partnerName ? { partnerName: identity.partnerName } : {}),
      ...(identity.primaryColor ? { primaryColor: identity.primaryColor } : {}),
      ...(logo && identity.logoSource
        ? {
          // Metadata only: never the bytes or the source URL (a data: URL can
          // be ~350 KB, and this entry is per device).
          logo: { sha256: logo.sha256, mime: logo.mime, bytes: logo.bytes },
          logoSourceKey: promptLogoSourceKey(identity.logoSource.trim()),
        }
        : {}),
    };
  }
  await writeDevicePolicyCache('prompt-identity', deviceId, orgId, result, PROMPT_IDENTITY_CACHE_TTL_SECONDS);
  return result;
}

/**
 * The identity a device's prompts are drawn under, cached per device (bound to
 * its org) for 120 s. `cleared` = the org resolves no partner row. Throws on a
 * DB error or a partner mismatch.
 *
 * Must be called OUTSIDE any held DB context: the read runs in its own short
 * system context and the logo may be fetched after it (#1105). Waits for the
 * logo (bounded by the loader's deadline); the heartbeat uses the non-waiting
 * path in buildHeartbeatPromptIdentity instead.
 */
export async function resolveDevicePromptIdentity(args: DevicePromptIdentityArgs): Promise<DevicePromptIdentity> {
  const identity = await resolveDeviceIdentity(args, 'await');
  // 'await' mode never reports pending.
  return identity ?? { state: 'cleared' };
}

/** The wire block (server-only keys dropped), validated against the shared contract; null if it would not parse. */
export function toPromptIdentityBlock(identity: DevicePromptIdentity): PromptIdentityBlock | null {
  const candidate = identity.state === 'cleared'
    ? { state: 'cleared' as const }
    : {
      state: 'set' as const,
      scopeId: identity.scopeId,
      ...(identity.partnerName ? { partnerName: identity.partnerName } : {}),
      ...(identity.primaryColor ? { primaryColor: identity.primaryColor } : {}),
      ...(identity.logo ? { logo: { sha256: identity.logo.sha256, mime: identity.logo.mime, bytes: identity.logo.bytes } } : {}),
    };
  const parsed = promptIdentityBlockSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error('[promptIdentity] resolved identity does not match the heartbeat contract; block omitted:', parsed.error.issues);
    return null;
  }
  return parsed.data;
}

/**
 * The heartbeat's `promptIdentity` block, or undefined when it cannot be
 * resolved this beat (logged; the agent keeps its last-known identity) or its
 * https logo is still being fetched in the background. Never waits on the
 * network, so a slow or hostile logo host cannot slow a heartbeat.
 */
export async function buildHeartbeatPromptIdentity(args: DevicePromptIdentityArgs): Promise<PromptIdentityBlock | undefined> {
  try {
    const identity = await resolveDeviceIdentity(args, 'warm');
    if (!identity) return undefined;
    return toPromptIdentityBlock(identity) ?? undefined;
  } catch (err) {
    console.error(
      `[promptIdentity] failed to resolve the prompt identity for device ${args.deviceId}; block omitted:`,
      { orgId: args.orgId, partnerId: args.partnerId ?? null },
      err,
    );
    return undefined;
  }
}

/**
 * The logo bytes for GET /agents/:id/prompt-identity/logo: only the
 * authenticated device's CURRENT logo, and only when `sha256` names it. The
 * lookup goes device → org → partner → source, never sha → bytes, so a sha
 * from another partner (or a stale one) can only miss.
 *
 * Must be called outside any held DB context (it may fetch).
 */
export async function loadDevicePromptLogo(args: DevicePromptIdentityArgs & { sha256: string }): Promise<PromptLogo | null> {
  const identity = await resolveDevicePromptIdentity(args);
  if (identity.state !== 'set' || !identity.logo || !identity.logoSourceKey) return null;
  if (identity.logo.sha256 !== args.sha256) return null;

  const cached = await readCachedPromptLogo(identity.logoSourceKey);
  if (cached && cached.sha256 === args.sha256) return cached;

  // The bytes left the logo cache (or failed since): resolve the source again,
  // uncached, and accept the reload only if it is still the same image.
  const fresh = await runOutsideDbContext(() => withSystemDbAccessContext(() => resolvePromptIdentity(args.orgId)));
  if (!fresh || fresh.partnerId !== args.partnerId || !fresh.logoSource) return null;
  const logo = await loadPromptIdentityLogo(fresh.logoSource, { partnerId: fresh.partnerId });
  return logo && logo.sha256 === args.sha256 ? logo : null;
}
