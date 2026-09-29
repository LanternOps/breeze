import type { DeviceTimeStatusView } from './types';
export interface FleetTimeRow {
  deviceId: string;
  hostname: string;
  orgId: string;
  orgName: string;
  siteId: string | null;
  siteName: string | null;
  view: DeviceTimeStatusView;
}
export interface FleetTimeDomain {
  orgId: string;
  domainDns: string;
  pdcEnrolled: boolean;
  pdcExpected: boolean;
  pdc: FleetTimeRow | null;
}
export interface FleetTimeResult {
  data: FleetTimeRow[];
  total: number;
  page: number;
  limit: number;
  domains: FleetTimeDomain[];
}
