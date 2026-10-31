export type AlertOwnerKind = 'device' | 'topology_site' | 'backup_workload';

export interface AlertOwnerFields {
  ownerKind: AlertOwnerKind;
  ownerRef: string | null;
  deviceId: string | null;
  topologySiteId: string | null;
  topologySourceKey: string | null;
}

/** Stable identity for throttles and logs. Throws on an illegal combination. */
export function alertOwnerKey(alert: AlertOwnerFields & { id?: string }): string {
  switch (alert.ownerKind) {
    case 'device':
      if (alert.deviceId !== null) return `device:${alert.deviceId}`;
      break;
    case 'topology_site':
      if (alert.topologySiteId !== null && alert.topologySourceKey !== null) {
        return `topology:${alert.topologySiteId}:${alert.topologySourceKey}`;
      }
      break;
    case 'backup_workload':
      if (alert.deviceId === null && alert.ownerRef !== null) return `backup_workload:${alert.ownerRef}`;
      break;
  }
  throw new Error(`Invalid alert owner: ${alert.ownerKind} (alert ${alert.id ?? 'unknown'})`);
}

/** Narrows provenance too: a topology owner may still carry a device. */
export function isDeviceOwned(alert: Pick<AlertOwnerFields, 'deviceId'>): alert is { deviceId: string } {
  return alert.deviceId !== null;
}
