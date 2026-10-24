// Files under components/topology/ permitted to call fetchWithAuth directly (not through
// topologyRead / topologyWrite in topologyApi.ts), with the reason. Keep this list short and justified.
export const TOPOLOGY_FETCH_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'TopologyArmStepUp.tsx', reason: 'step-up reads /users/me and /auth/passkeys: account routes, not topology routes, so the device-org pin does not apply' },
];
