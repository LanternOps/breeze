import { createHash } from 'node:crypto';

export const PARTNER_EXPORT_DERIVED_ID_NAMESPACE = {
  interface: 'interface',
  address: 'address',
  virtualMachine: 'hyperv-vm',
} as const;

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

export function stablePartnerExportInterfaceUuid(
  deviceId: string,
  interfaceName: string,
  macAddress: string | null,
): string {
  return stablePartnerExportUuid(
    PARTNER_EXPORT_DERIVED_ID_NAMESPACE.interface,
    `${deviceId}:${interfaceName}:${macAddress ?? ''}`,
  );
}

export function stablePartnerExportAddressUuid(
  deviceId: string,
  interfaceName: string,
  address: string,
  family: string,
): string {
  return stablePartnerExportUuid(
    PARTNER_EXPORT_DERIVED_ID_NAMESPACE.address,
    `${deviceId}:${interfaceName}:${address}:${family}`,
  );
}

export function stablePartnerExportVmUuid(deviceId: string, vmId: string): string {
  return stablePartnerExportUuid(
    PARTNER_EXPORT_DERIVED_ID_NAMESPACE.virtualMachine,
    `${deviceId}:${vmId}`,
  );
}
