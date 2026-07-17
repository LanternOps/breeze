import { createHash } from 'node:crypto';

export const PARTNER_EXPORT_DERIVED_ID_NAMESPACE = {
  interface: 'interface',
  address: 'address',
  virtualMachine: 'hyperv-vm',
} as const;

/**
 * Build a deterministic, namespace-separated UUID with the legacy version-5
 * nibble and RFC variant bits. This is not the RFC UUIDv5 namespace algorithm;
 * MD5 is used only as a compact identity hash, never for security.
 */
export function stablePartnerExportUuid(namespace: string, sourceIdentity: string): string {
  const digest = createHash('md5').update(`${namespace}:${sourceIdentity}`).digest('hex').split(''); // lgtm[js/weak-cryptographic-algorithm]
  digest[12] = '5';
  digest[16] = 'a';
  const value = digest.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Exact cross-runtime identity contract for derived export resources.
 *
 * TypeScript uses JSON.stringify(string[]) and PostgreSQL must use
 * array_to_json(ARRAY[... ]::text[])::text, which both produce compact JSON
 * text with no delimiter ambiguity. SQL calls the
 * breeze_partner_export_stable_uuid(namespace text, source_identity text)
 * overload with this encoded text.
 */
export function encodePartnerExportIdentityComponents(components: readonly string[]): string {
  return JSON.stringify(components);
}

export function stablePartnerExportInterfaceUuid(
  deviceId: string,
  interfaceName: string,
  macAddress: string | null,
): string {
  return stablePartnerExportUuid(
    PARTNER_EXPORT_DERIVED_ID_NAMESPACE.interface,
    encodePartnerExportIdentityComponents([deviceId, interfaceName, macAddress ?? '']),
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
    encodePartnerExportIdentityComponents([deviceId, interfaceName, address, family]),
  );
}

export function stablePartnerExportVmUuid(deviceId: string, vmId: string): string {
  return stablePartnerExportUuid(
    PARTNER_EXPORT_DERIVED_ID_NAMESPACE.virtualMachine,
    encodePartnerExportIdentityComponents([deviceId, vmId]),
  );
}
