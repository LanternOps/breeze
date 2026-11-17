// Files under components/topology/ permitted to call fetchWithAuth directly (not through
// topologyRead / topologyWrite in topologyApi.ts), with the reason. Keep this list short and justified.
export const TOPOLOGY_FETCH_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  // TopologyArmStepUp.tsx left the list: its factor read moved to lib/reauthTier.ts (#8318 2-3 review).
];
