export interface WarrantyEntitlement {
  provider: 'dell' | 'hp' | 'lenovo' | 'apple';
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
  /**
   * Vendor ship date (YYYY-MM-DD) when the provider reports one — Dell
   * `shipDate`, Lenovo `machineInfo.shipDate`. Feeds the device's
   * vendor-sourced purchase date for the Hardware Lifecycle report; never
   * overwrites an operator-entered ('manual') purchase date.
   */
  shipDate?: string | null;
  error?: string;
}

export interface WarrantyProvider {
  name: string;
  supports(manufacturer: string): boolean;
  lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>>;
  isConfigured(): boolean;
}
