import type {
  ResolvedTopologySettings,
  TopologyConfigurationPayload,
} from '@breeze/shared';
export type { ResolvedTopologySettings, TopologyConfigurationPayload };
export interface TopologySettingsLayers {
  defaultsVersion: number;
  schemaVersion: 1;
  resolverVersion: number;
  defaults: TopologyConfigurationPayload;
  partner?: { versionId: string; payload: TopologyConfigurationPayload };
  organization?: { versionId: string; payload: TopologyConfigurationPayload };
  site?: TopologyConfigurationPayload;
}
