export type RegionKey = 'us' | 'eu';

export interface Region {
  key: RegionKey;
  baseUrl: string;   // web origin; API is baseUrl + /api/v1
  apiUrl: string;
}

export const REGIONS: Record<RegionKey, Region> = {
  us: { key: 'us', baseUrl: 'https://us.2breeze.app', apiUrl: 'https://us.2breeze.app/api/v1' },
  eu: { key: 'eu', baseUrl: 'https://eu.2breeze.app', apiUrl: 'https://eu.2breeze.app/api/v1' },
};

export function parseRegions(arg: string | undefined): Region[] {
  const v = (arg ?? 'both').toLowerCase();
  if (v === 'both') return [REGIONS.us, REGIONS.eu];
  if (v === 'us' || v === 'eu') return [REGIONS[v]];
  throw new Error(`--region must be us|eu|both, got "${arg}"`);
}
