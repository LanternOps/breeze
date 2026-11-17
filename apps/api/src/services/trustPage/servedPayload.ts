// The one reader of a published snapshot for the public surfaces (payload, card, documents, attestation and the
// access flow). It applies the deployment's CIS framework-view switch at READ time (#9087, amendment 25): a snapshot
// built while BREEZE_TRUST_CIS_FRAMEWORK_VIEW was on stops serving CIS v8 content on the next request after the switch
// turns off, without waiting for the hourly refresh or a republish, and without touching the stored snapshot, its
// hash or the cache.
import { normalizeTrustPagePayload, type TrustPagePublicPayload } from '@breeze/shared';
import { trustCisFrameworkViewEnabled } from '../../config/env';
import { frameworkAttributions } from './payloadBuilder';
import type { ResolvedTrustPage } from './resolve';
import { cacheSnapshotPayload, readCachedSnapshotPayload } from './servingSet';

/**
 * Pure. While the switch is off: CIS v8 leaves the framework view, every control's `safeguards` (CIS content, W3e)
 * is removed, and the footer drops `cis_v8` unless the gated content still cites it. CIS refs on control cards are
 * never touched (amendment 25: chips and attribution stay). The identity when the switch is on, or when there is
 * nothing to gate.
 */
export function gateCisFrameworkView(p: TrustPagePublicPayload, enabled: boolean): TrustPagePublicPayload {
  if (enabled) return p;
  if (!p.frameworks.includes('cis_v8') && !p.controls.some((c) => c.safeguards !== undefined)) return p;
  const controls = p.controls.map(({ safeguards: _cis, ...c }) => c);
  const gated = { ...p, controls, frameworks: p.frameworks.filter((f) => f !== 'cis_v8') };
  const stillCitesCis = frameworkAttributions(gated).includes('cis_v8');
  return {
    ...gated,
    footer: { ...p.footer, frameworkAttributions: p.footer.frameworkAttributions.filter((f) => f !== 'cis_v8' || stillCitesCis) },
  };
}

/**
 * The current snapshot's payload as served: the Redis copy, else the stored one (cached ungated on the way), then
 * normalized to v2 and gated. Null when the page has no snapshot payload.
 */
export async function loadServedPayload(r: Pick<ResolvedTrustPage, 'snapshotId' | 'payload'>): Promise<TrustPagePublicPayload | null> {
  if (!r.snapshotId) return null;
  const cached = await readCachedSnapshotPayload(r.snapshotId);
  const stored = cached ?? r.payload;
  if (!stored) return null;
  if (!cached) await cacheSnapshotPayload(r.snapshotId, stored);
  return gateCisFrameworkView(normalizeTrustPagePayload(stored), trustCisFrameworkViewEnabled());
}
