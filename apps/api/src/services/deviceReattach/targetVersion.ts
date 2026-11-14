/**
 * The opaque version of a reattach target's install (#8318 wave 2-2, spec §8).
 *
 * The reattach dialog and the `device_reattach` step-up must pin the exact
 * install of the target the technician was shown (its `agent_id` and
 * `install_incarnation`), so that a target which re-enrolls or is reattached
 * meanwhile invalidates both. Neither raw value leaves the API: the candidates
 * read hands out this HMAC instead, and the request recomputes it from the
 * LOCKED target row and compares in constant time.
 *
 * Key: a service-scoped key derived from the deployment's secret-encryption
 * keyring (`getSecretDerivedKeyMaterials`, the same source as the topology
 * cursors). New versions use the active key; a supplied one is accepted under
 * any retained key, so a key rotation between the read and the request does
 * not strand an open dialog.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecretDerivedKeyMaterials } from '../secretCrypto';
import { REATTACH_TARGET_VERSION_PATTERN } from './protocol';

export { REATTACH_TARGET_VERSION_PATTERN };

const DOMAIN = 'device-reattach-target-version';

export interface ReattachTargetInstall {
  targetDeviceId: string;
  agentId: string;
  installIncarnation: number;
}

function mac(key: Buffer, install: ReattachTargetInstall): Buffer {
  return createHmac('sha256', key)
    .update(`${DOMAIN}\0${install.targetDeviceId.trim().toLowerCase()}:${install.agentId}:${Math.trunc(install.installIncarnation)}`)
    .digest();
}

/** The version of this install, under the active key. */
export function reattachTargetVersion(install: ReattachTargetInstall): string {
  return mac(getSecretDerivedKeyMaterials(DOMAIN).active.key, install).toString('base64url');
}

/** Whether `supplied` is the version of this install under any retained key. Constant time per key. */
export function reattachTargetVersionMatches(supplied: string, install: ReattachTargetInstall): boolean {
  if (!REATTACH_TARGET_VERSION_PATTERN.test(supplied)) return false;
  const given = Buffer.from(supplied, 'base64url');
  if (given.length !== 32) return false;
  const { active, retained } = getSecretDerivedKeyMaterials(DOMAIN);
  let matched = false;
  for (const { key } of [active, ...retained]) {
    // Evaluate every key, so the time does not tell which one matched.
    if (timingSafeEqual(given, mac(key, install))) matched = true;
  }
  return matched;
}
