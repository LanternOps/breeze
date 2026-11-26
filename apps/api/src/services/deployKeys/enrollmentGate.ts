/**
 * Pure decisions of the deploy-key enrollment branch
 * (routes/agents/enrollmentDeployKey.ts, #8318 wave D-1): which refusal a
 * key's state earns, and whether the enrollment source passes the key's
 * optional CIDR allow-list.
 */
import { ipMatchesAny } from '../ipMatch';

export type DeployKeyKeyRefusalReason =
  | 'deploy_key_not_found'
  | 'deploy_key_revoked'
  | 'deploy_key_expired'
  | 'deploy_key_exhausted';

/** The first refusal a key's state earns, or null when it may enroll. */
export function deployKeyStateRefusal(key: { status: string; expired: boolean; usageCount: number; maxUsage: number }): DeployKeyKeyRefusalReason | null {
  if (key.status !== 'active') return 'deploy_key_revoked';
  if (key.expired) return 'deploy_key_expired';
  if (key.usageCount >= key.maxUsage) return 'deploy_key_exhausted';
  return null;
}

/** Node reports an IPv4 peer on a dual-stack socket as ::ffff:a.b.c.d. */
function unmapIpv4(ip: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return match ? match[1]! : ip;
}

/** Whether the enrollment source may use a key with this allow-list. */
export function sourceAllowed(sourceCidrs: readonly string[] | null, enrollmentIp: string | null): boolean {
  if (!sourceCidrs || sourceCidrs.length === 0) return true;
  if (!enrollmentIp) return false;
  return ipMatchesAny(unmapIpv4(enrollmentIp), [...sourceCidrs]);
}

