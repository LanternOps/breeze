import { createHash } from 'node:crypto';

/**
 * Build a deterministic, namespace-separated UUID with RFC version/variant
 * bits. MD5 is used only as a compact identity hash, never for security.
 */
export function stablePartnerExportUuid(namespace: string, sourceIdentity: string): string {
  const digest = createHash('md5').update(`${namespace}:${sourceIdentity}`).digest('hex').split(''); // lgtm[js/weak-cryptographic-algorithm]
  digest[12] = '5';
  digest[16] = 'a';
  const value = digest.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
