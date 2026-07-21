import type { PartnerExportResource } from './schemas';

export type Disposition = 'machine-observed' | 'customer-authored';

export interface ResourceClassification {
  default: Disposition;
  /** Normalized paths (every array index collapsed to `[]`) whose disposition differs from `default`. */
  exceptions?: Record<string, Disposition>;
}

/**
 * Which fields the generic structural (entropy) secret layer runs on.
 *
 * The layer runs iff a field's effective disposition is `customer-authored`
 * (something a person can type, where a pasted secret is plausible). Fields that
 * are agent/inventory facts are `machine-observed` and skip the structural layer
 * — the two precise layers (known token patterns, secret-named field names) still
 * scan them. Inventory resources are wholly machine-observed, so they default off;
 * `devices` is mixed (customer display name + tags alongside machine identity), so
 * its machine-identity fields are per-field exceptions.
 *
 * The `Record<PartnerExportResource, …>` type makes a NEW resource a compile error
 * until classified — the fail-loud guard for the common mistake.
 */
export const RESOURCE_CLASSIFICATION: Record<PartnerExportResource, ResourceClassification> = {
  organizations: { default: 'customer-authored' },
  sites: { default: 'customer-authored' },
  devices: {
    default: 'customer-authored',
    exceptions: {
      hostname: 'machine-observed',
      'hardwareIdentity.serialNumber': 'machine-observed',
      'hardwareIdentity.manufacturer': 'machine-observed',
      'hardwareIdentity.model': 'machine-observed',
    },
  },
  'device-inventory': { default: 'machine-observed' },
  'device-software': { default: 'machine-observed' },
  'device-relationships': { default: 'machine-observed' },
  scripts: { default: 'customer-authored' },
  automations: { default: 'customer-authored' },
  'configuration-policies': { default: 'customer-authored' },
  'configuration-assignments': { default: 'customer-authored' },
  'backup-configurations': { default: 'customer-authored' },
  'custom-fields': { default: 'customer-authored' },
  'custom-field-values': { default: 'customer-authored' },
};

export function normalizeClassificationPath(path: string): string {
  return path.replace(/\[\d+\]/gu, '[]');
}

export function resolveDisposition(resource: PartnerExportResource, normalizedPath: string): Disposition {
  const classification = RESOURCE_CLASSIFICATION[resource];
  return classification.exceptions?.[normalizedPath] ?? classification.default;
}

export function shouldRunStructuralLayer(resource: PartnerExportResource, path: string): boolean {
  return resolveDisposition(resource, normalizeClassificationPath(path)) === 'customer-authored';
}
