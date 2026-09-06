// Formatting helpers and label-key lookup tables for the network device
// detail page. Grouped here (rather than inline in each section) because
// they're pure functions/constants with no JSX and no page state, reused
// across the identity, ports, and SNMP sections.

import { formatDateTime } from '@/lib/dateTimeFormat';
import type { PortKind } from '../../discovery/portCatalog';

// A whitespace-only string is functionally empty but is not `null`/`undefined`,
// so a `??` fallback never catches it — it used to render as a blank cell.
export function isBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

export function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

// Kinds that get a muted label on their row instead of an action or a
// warning badge. 'web' rows get the Open button and 'insecure'/risky rows get
// the Unencrypted badge (both handled inline where the row is rendered), so
// they're deliberately absent here. 'other' is also absent on purpose — it's
// the catch-all for uncatalogued/plain ports, so there's no meaningful kind
// label to show; the row just renders the port number and service name with
// no trailing badge, and no locale key is ever consulted for it.
export const PORT_KIND_LABEL_KEYS: Partial<Record<PortKind, string>> = {
  mgmt: 'networkDeviceDetailPage.ports.kind.mgmt',
  remote: 'networkDeviceDetailPage.ports.kind.remote',
  print: 'networkDeviceDetailPage.ports.kind.print',
  file: 'networkDeviceDetailPage.ports.kind.file',
};

// Translation keys for the scalar SNMP system OIDs the discovery scan
// collects. Values live in locale under `networkDeviceDetailPage.snmpFields`;
// an unrecognized key (a vendor-specific OID the UI doesn't have a friendly
// name for) falls back to the raw key rather than a translation lookup.
export const SNMP_FIELD_LABEL_KEYS: Record<string, string> = {
  sysName: 'networkDeviceDetailPage.snmpFields.sysName',
  sysDescr: 'networkDeviceDetailPage.snmpFields.sysDescr',
  sysObjectId: 'networkDeviceDetailPage.snmpFields.sysObjectId',
};

export function snmpFieldLabel(key: string, t: (key: string) => string): string {
  const labelKey = SNMP_FIELD_LABEL_KEYS[key];
  return labelKey ? t(/* i18n-dynamic */ labelKey) : key;
}
