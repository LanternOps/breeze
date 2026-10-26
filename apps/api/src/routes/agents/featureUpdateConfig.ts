/**
 * Heartbeat config block `feature_update_settings`: the update ring's decision
 * on Windows feature releases (block | allow | pin), resolved for one device.
 *
 * Kept out of helpers.ts so the heartbeat's import graph does not pull
 * configPolicyPatching into every helpers.*.test.ts module mock.
 */
import { DEFAULT_RING_FEATURE_UPDATES, type RingFeatureUpdates } from '@breeze/shared/validators';
import { loadPolicyLocalPatchConfig } from '../../services/configPolicyPatching';
import type { DevicePolicySetOpts } from '../../services/devicePolicySet';
import { resolvePatchConfigPolicyForDevice } from '../../services/featureConfigResolver';

/**
 * Wire shape (contract D6: snake_case inside the block). The agent's
 * ParseFeatureUpdatePolicy accepts either spelling.
 */
export interface FeatureUpdateSettingsWire {
  mode: RingFeatureUpdates['mode'];
  product?: string;
  target_version?: string;
}

export function toFeatureUpdateSettingsWire(policy: RingFeatureUpdates): FeatureUpdateSettingsWire {
  if (policy.mode === 'pin') {
    return { mode: 'pin', product: policy.product, target_version: policy.targetVersion };
  }
  return { mode: policy.mode };
}

/**
 * The device's effective feature-update policy: the ring linked by its winning
 * patch feature. Fails closed to block for a device with no patch policy, a
 * policy with no ring, or a ring reference that does not resolve — the agent
 * then filters feature releases out and reverts any pin Breeze wrote. The
 * caller omits the block on a resolver error so a transient failure never
 * flips a fleet's pin.
 */
export async function buildFeatureUpdateConfigUpdate(
  deviceId: string,
  opts?: DevicePolicySetOpts,
): Promise<RingFeatureUpdates> {
  const resolved = await resolvePatchConfigPolicyForDevice(deviceId, opts);
  if (!resolved) return DEFAULT_RING_FEATURE_UPDATES;
  const policyLocal = await loadPolicyLocalPatchConfig(resolved.configPolicyId);
  if (!policyLocal || !policyLocal.ring.valid || !policyLocal.ring.ringId) return DEFAULT_RING_FEATURE_UPDATES;
  return policyLocal.ring.featureUpdates;
}
