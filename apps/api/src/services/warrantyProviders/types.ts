export interface WarrantyEntitlement {
  provider: 'dell' | 'hp' | 'lenovo';
  serviceLevelDescription: string;
  entitlementType: string;
  startDate: string;
  endDate: string;
}

export interface WarrantyLookupResult {
  found: boolean;
  entitlements: WarrantyEntitlement[];
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  error?: string;
}

export interface WarrantyProvider {
  name: string;
  supports(manufacturer: string): boolean;
  lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>>;
  isConfigured(): boolean;
}
