type JsonRecord = Record<string, unknown>;

export interface Pax8CompanyOrderReadiness {
  statusActive: boolean;
  primaryAdminReady: boolean;
  primaryBillingReady: boolean;
  primaryTechnicalReady: boolean;
  orderReady: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/**
 * Projects only the ordering capability required by Pax8. Contact PII and the
 * raw company payload never leave the server. Missing contact evidence is
 * deliberately unknown/not-ready even when the company says Active.
 */
export function pax8CompanyOrderReadiness(
  status: string | null | undefined,
  metadata: unknown,
): Pax8CompanyOrderReadiness {
  const statusActive = status?.trim().toLowerCase() === 'active';
  const record = asRecord(metadata);
  const contacts = Array.isArray(record?.contacts) ? record.contacts : [];
  const primaryTypes = new Set<string>();

  for (const candidate of contacts) {
    const contact = asRecord(candidate);
    if (!contact || !Array.isArray(contact.types)) continue;
    for (const value of contact.types) {
      const type = asRecord(value);
      if (type?.primary !== true || typeof type.type !== 'string') continue;
      primaryTypes.add(type.type.trim().toLowerCase());
    }
  }

  const primaryAdminReady = primaryTypes.has('admin');
  const primaryBillingReady = primaryTypes.has('billing');
  const primaryTechnicalReady = primaryTypes.has('technical');
  return {
    statusActive,
    primaryAdminReady,
    primaryBillingReady,
    primaryTechnicalReady,
    orderReady: statusActive
      && primaryAdminReady
      && primaryBillingReady
      && primaryTechnicalReady,
  };
}
