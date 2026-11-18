import { z } from 'zod';

/**
 * Update Ring Windows feature-update policy — `patch_policies.feature_updates`.
 *
 * A ring decides whether the devices it covers receive Windows feature
 * releases ("Windows 11, version 25H2"):
 *
 *  - `block` (default): never offered. The agent filters them out of its scan
 *    and the approval evaluator denies any that still arrive. Identical to the
 *    agent's behaviour before this control existed.
 *  - `allow`: the newest release Windows Update offers is reported and goes
 *    through the ring's normal approval rules (a `feature` category override
 *    with auto-approve installs it automatically).
 *  - `pin`: only the named release passes; the agent also writes the Windows
 *    Update for Business TargetReleaseVersion policy so Windows itself offers
 *    and holds at that release.
 *
 * The agent parses the same shape (patching.ParseFeatureUpdatePolicy); keep
 * the field names and the product ids in sync.
 */
export const FEATURE_UPDATE_PRODUCTS = ['windows-11', 'windows-10'] as const;
export type FeatureUpdateProduct = (typeof FEATURE_UPDATE_PRODUCTS)[number];

/** A Windows release token: two digits, H, 1 or 2 — e.g. 25H2. */
const RELEASE_TOKEN = /^\d{2}H[12]$/i;

export const ringFeatureUpdatesSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('block') }),
  z.object({ mode: z.literal('allow') }),
  z.object({
    mode: z.literal('pin'),
    product: z.enum(FEATURE_UPDATE_PRODUCTS),
    targetVersion: z
      .string()
      .trim()
      .regex(RELEASE_TOKEN, 'Enter a release like 25H2.')
      .transform((v) => v.toUpperCase()),
  }),
]);

export type RingFeatureUpdates = z.infer<typeof ringFeatureUpdatesSchema>;

export const DEFAULT_RING_FEATURE_UPDATES: RingFeatureUpdates = { mode: 'block' };

/**
 * How Windows Update titles a feature release: the title STARTS with the
 * product (optionally after "Feature update to" / "Upgrade to"), then
 * "version <release>" — "Windows 11, version 24H2", "Feature update to
 * Windows 10, version 22H2 via Enablement Package (KB5015684)". Anchoring at
 * the start keeps everything that merely names a release out: "2026-10
 * Cumulative Update for Windows 11 Version 24H2 …", ".NET Framework 4.8.1 for
 * Windows 11, version 24H2 …". The agent's windowsFeatureUpdateTitlePattern is
 * the same expression; keep them identical.
 */
const WINDOWS_FEATURE_UPDATE_TITLE = /^\s*(?:feature update to |upgrade to )?windows (10|11)\b[^\d]*?\bversion (\d{2}H[12])\b/i;

export function parseWindowsFeatureUpdateTitle(
  title: string,
): { product: FeatureUpdateProduct; version: string } | null {
  const m = WINDOWS_FEATURE_UPDATE_TITLE.exec(title);
  if (!m) return null;
  return { product: `windows-${m[1]}` as FeatureUpdateProduct, version: m[2]!.toUpperCase() };
}

/**
 * Whether a patch candidate is a Windows feature release the ring policy
 * governs: Microsoft source, the agent's `feature` category (WUA Upgrades /
 * Feature Packs) and a release title. A .NET "Feature Pack" has no release
 * token and is left to the ordinary category rules.
 */
export function isWindowsFeatureUpdateCandidate(patch: {
  source: string;
  category: string | null;
  title: string;
}): boolean {
  return patch.source === 'microsoft' && patch.category === 'feature' && parseWindowsFeatureUpdateTitle(patch.title) !== null;
}

/** The policy decision for one feature-update title. `pin` is an exact product + release match. */
export function featureUpdateAllowed(policy: RingFeatureUpdates, title: string): boolean {
  switch (policy.mode) {
    case 'allow':
      return true;
    case 'pin': {
      const parsed = parseWindowsFeatureUpdateTitle(title);
      return parsed !== null && parsed.product === policy.product && parsed.version === policy.targetVersion.toUpperCase();
    }
    default:
      return false;
  }
}

/**
 * Read a stored `feature_updates` value with a fail-closed fallback: anything
 * that does not parse is `block`. Callers that want to report drift check
 * `parsed.success` themselves via the schema.
 */
export function coerceRingFeatureUpdates(raw: unknown): RingFeatureUpdates {
  const parsed = ringFeatureUpdatesSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_RING_FEATURE_UPDATES;
}
