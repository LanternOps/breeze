/**
 * Topology capability -> minimum permission grants. A leaf module (no DB,
 * middleware or route imports): `aiSessionAccess.ts` needs only this table and
 * is reachable from the worker's boot closure via aiCostTracker, which must
 * not reach `middleware/auth.ts` -> `routes/auth/schemas.ts`
 * (workerEntrypointClosure.contract.test.ts). `access.ts` re-exports it.
 */
export type TopologyCapability = 'read' | 'write' | 'execute' | 'configure';

export type TopologyPermissionPair = readonly [resource: string, action: string];

/**
 * Minimum grants for each topology capability. Execution still requires the
 * action path's MFA, target/origin, and current-authority checks.
 */
export function topologyPermissionPairs(
  capability: TopologyCapability,
): TopologyPermissionPair[] {
  const read: TopologyPermissionPair[] = [
    ['topology', 'read'],
    ['devices', 'read'],
  ];

  switch (capability) {
    case 'read':
      return read;
    case 'write':
      return [...read, ['topology', 'write']];
    case 'execute':
      return [...read, ['topology', 'execute'], ['devices', 'execute']];
    case 'configure':
      return [
        ...read,
        ['topology', 'write'],
        ['devices', 'write'],
        ['devices', 'execute'],
      ];
  }
}
