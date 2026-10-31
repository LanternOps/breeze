// CSV export of the Devices list (#9726). Pure builder: DeviceList decides
// WHICH devices (the full filtered set, or the checked rows) and WHICH columns
// (visible, in drawn order); this turns them into text. Every cell goes through
// `toCsv`, so a hostname that starts with `=` cannot become a spreadsheet
// formula.
//
// Cells carry the value the table cell shows, but machine-friendly: ISO
// timestamps, bare numbers, and an empty cell where the table draws a dash.
// Headers are the stable English COLUMN_LABELS (the Column chooser's labels),
// not the translated table headers, so a file diffs and scripts the same in
// every locale.
import { toCsv } from '../../lib/csvExport';
import { dropdownChoiceLabel } from '../../lib/customFieldChoice';
import { getDeviceRoleLabel } from '../../lib/deviceRoles';
import { getVpnProviderLabel, vpnList } from '../../lib/vpnProviders';
import type { DeviceAttention } from './deviceAttentionCounts';
import { ATTENTION_SEVERITIES } from './deviceAttentionCounts';
import { COLUMN_LABELS, type ColumnId } from './columnVisibility';
import { formatDeviceOsVersion } from './osDisplay';
import type { Device } from './DeviceList';

export type ExportCustomFieldDef = {
  fieldKey: string;
  name: string;
  type: string;
  options?: { choices?: Array<string | { label: string; value: string }> } | null;
};

/** `undefined` = the id was not fetched/does not apply; 'failed' = request failed. */
export type AttentionExportValue = DeviceAttention | null | 'failed';

export type DevicesCsvInput = {
  devices: readonly Device[];
  /** Visible columns in drawn order. Hostname is forced to the front. */
  columns: readonly ColumnId[];
  customFieldDefs: readonly ExportCustomFieldDef[];
  /** Localised status label (the table's Status text). */
  statusLabel: (device: Device) => string;
  /** Present only when the Attention column is exported. */
  attention?: ReadonlyMap<string, AttentionExportValue>;
};

const OS_LABELS: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

const isAgent = (d: Device) => (d.deviceClass ?? 'agent') === 'agent';

function serverHost(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

function isoOrEmpty(raw: string | null | undefined): string {
  if (!raw) return '';
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

export function formatAttentionForCsv(value: AttentionExportValue | undefined): string {
  if (value === 'failed') return 'unavailable';
  if (!value) return '';
  const parts: string[] = [];
  const alerts = ATTENTION_SEVERITIES.filter((sev) => value.alerts[sev] > 0).map(
    (sev) => `${sev} ${value.alerts[sev]}`,
  );
  if (alerts.length > 0) parts.push(`alerts: ${alerts.join(', ')}`);
  if (value.tickets > 0) parts.push(`tickets: ${value.tickets}`);
  return parts.join('; ');
}

type Cell = string | number | null | undefined;

function columnCell(id: ColumnId, d: Device, input: DevicesCsvInput): Cell {
  const cls = d.deviceClass ?? 'agent';
  switch (id) {
    case 'hostname': return d.displayName || d.hostname;
    case 'class': return cls === 'manual' ? 'Manual' : cls === 'network' ? 'Network' : 'Agent';
    case 'type': return cls === 'agent' ? '' : getDeviceRoleLabel(d.assetType ?? 'unknown');
    case 'organization': return d.orgName;
    case 'site': return d.siteName;
    case 'os': return OS_LABELS[d.os] ?? '';
    case 'osVersion': return formatDeviceOsVersion(d.os, d.osVersion);
    case 'osBuild': return d.osBuild;
    case 'architecture': return d.architecture;
    case 'role': return cls === 'agent' ? getDeviceRoleLabel(d.deviceRole ?? 'unknown') : '';
    case 'isHeadless': return typeof d.isHeadless === 'boolean' ? (d.isHeadless ? 'Yes' : 'No') : '';
    case 'status': return input.statusLabel(d);
    case 'attention': return isAgent(d) ? formatAttentionForCsv(input.attention?.get(d.id)) : '';
    case 'pendingReboot': return d.pendingReboot ? 'Yes' : '';
    case 'cpu': return isAgent(d) && d.status === 'online' ? d.cpuPercent : '';
    case 'ram': return isAgent(d) && d.status === 'online' ? d.ramPercent : '';
    case 'power':
      return d.batteryStatus?.present && typeof d.batteryStatus.percent === 'number'
        ? d.batteryStatus.percent
        : '';
    case 'cpuModel': return d.hardware?.cpuModel;
    case 'cores': return d.hardware?.cpuCores;
    case 'ramTotal': return d.hardware?.ramTotalMb;
    case 'diskTotal': return d.hardware?.diskTotalGb;
    case 'lastSeen': return isoOrEmpty(d.lastSeen);
    case 'agentVersion': return d.agentVersion;
    case 'watchdogVersion': return d.watchdogVersion?.trim();
    case 'helperVersion': return d.helperVersion?.trim();
    case 'serverUrl': return serverHost(d.agentServerUrl);
    case 'wanIp': return d.wanIp;
    case 'lanIp': return d.lanIp;
    case 'tags': return d.tags?.join(', ');
    case 'lastUser': return d.lastUser;
    case 'uptime': return d.status === 'online' ? d.uptimeSeconds : '';
    case 'enrolled': return isoOrEmpty(d.enrolledAt);
    case 'desktopAccess': return d.desktopAccess?.mode;
    case 'reliability': return typeof d.reliabilityScore === 'number' ? d.reliabilityScore : '';
    case 'hardwareHealth': return d.hardwareHealth;
    case 'vpn': return vpnList(d.activeVpns).map((v) => getVpnProviderLabel(v.provider)).join(', ');
    case 'serial':
      return cls === 'manual' ? d.serialNumber : cls === 'agent' ? d.hardware?.serialNumber : '';
    case 'assetTag': return cls === 'manual' ? d.assetTag : '';
    case 'location': return cls === 'manual' ? d.location : '';
    case 'source': return cls === 'network' ? d.source : '';
  }
}

function customFieldCell(def: ExportCustomFieldDef, d: Device): string {
  const value = d.customFields?.[def.fieldKey];
  if (value === null || value === undefined || value === '') return '';
  const choice = dropdownChoiceLabel(def, value);
  if (choice !== undefined) return choice;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Columns to export: hostname first (always), then the rest in the order given. */
export function exportColumns(columns: readonly ColumnId[]): ColumnId[] {
  return ['hostname', ...columns.filter((c) => c !== 'hostname')];
}

export function buildDevicesCsv(input: DevicesCsvInput): string {
  const columns = exportColumns(input.columns);
  const header = [...columns.map((c) => COLUMN_LABELS[c]), ...input.customFieldDefs.map((d) => d.name)];
  const rows = input.devices.map((d) => [
    ...columns.map((c) => columnCell(c, d, input)),
    ...input.customFieldDefs.map((def) => customFieldCell(def, d)),
  ]);
  return toCsv(header, rows);
}

export function devicesCsvFilename(now: Date = new Date()): string {
  return `devices-${now.toISOString().slice(0, 10)}.csv`;
}
