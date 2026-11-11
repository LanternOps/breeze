import type { AlertOwnerKind, AlertSubject } from '../types';
import { saasWorkloadLabel } from './backupHealth';

export interface AlertSubjectSource {
  ownerKind?: AlertOwnerKind | null;
  ownerRef?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  deviceHostname?: string | null;
  topologySiteId?: string | null;
  siteName?: string | null;
  orgName?: string | null;
}

export interface AlertWorkloadSubject {
  dataSources?: string[] | null;
  customerName?: string | null;
  providerLabel?: string | null;
  portalShowProviderName?: boolean;
}

/** Never use provider identifiers or vendor item names as customer-facing text. */
export function formatAlertSubject(
  alert: AlertSubjectSource,
  workload?: AlertWorkloadSubject,
  options: { portal?: boolean } = {},
): AlertSubject {
  const ownerKind = alert.ownerKind ?? 'device';
  if (ownerKind === 'backup_workload') {
    const labels = [...new Set((workload?.dataSources ?? []).map(saasWorkloadLabel))];
    const label = `${labels.length ? labels.join(', ') : 'SaaS'} backup`;
    const ownerLabel = options.portal && workload?.portalShowProviderName && workload.providerLabel
      ? `${label} (${workload.providerLabel})` : label;
    const customer = workload?.customerName || alert.orgName;
    return { ownerKind, owner: { kind: ownerKind, ref: alert.ownerRef ?? null }, ownerLabel, subjectName: customer ? `${ownerLabel} · ${customer}` : ownerLabel };
  }
  if (ownerKind === 'topology_site') {
    const ownerLabel = alert.siteName || 'Topology site';
    return { ownerKind, owner: { kind: ownerKind, ref: alert.topologySiteId ?? null }, ownerLabel, subjectName: ownerLabel };
  }
  const ownerLabel = alert.deviceName || alert.deviceHostname || 'Device';
  return { ownerKind, owner: alert.deviceId ? { kind: ownerKind, ref: alert.deviceId } : null, ownerLabel, subjectName: ownerLabel };
}
