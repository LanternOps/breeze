import type { z } from 'zod';
import type {
  unifiClientRowV2Schema, unifiDeviceDetailRowV2Schema, unifiDeviceRowV2Schema, unifiRadioOverviewSchema, unifiRadioStatisticsSchema,
  unifiResourceV2Schema, unifiStatisticsRowV2Schema, unifiTopologyV2Schema,
} from '../validators/topologyUnifiV2';

export type UnifiDeviceRowV2 = z.infer<typeof unifiDeviceRowV2Schema>;
export type UnifiClientRowV2 = z.infer<typeof unifiClientRowV2Schema>;
export type UnifiDeviceDetailRowV2 = z.infer<typeof unifiDeviceDetailRowV2Schema>;
export type UnifiStatisticsRowV2 = z.infer<typeof unifiStatisticsRowV2Schema>;
export type WirelessRadioOverview = z.infer<typeof unifiRadioOverviewSchema>;
export type WirelessRadioStatistics = z.infer<typeof unifiRadioStatisticsSchema>;
export type UnifiResourceV2 = z.infer<typeof unifiResourceV2Schema>;
export type UnifiTopologyV2 = z.infer<typeof unifiTopologyV2Schema>;
